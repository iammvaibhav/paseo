import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { ProjectCreateDirectoryErrorCode } from "@getpaseo/protocol/messages";
import { expandTilde } from "../utils/path.js";
import { runGitCommand } from "../utils/run-git-command.js";
import type { PersistedProjectRecord } from "./workspace-registry.js";

export class ProjectDirectoryRequestError extends Error {
  constructor(
    readonly code: ProjectCreateDirectoryErrorCode,
    message: string,
    readonly directoryPath: string | null = null,
  ) {
    super(message);
    this.name = "ProjectDirectoryRequestError";
  }
}

export interface CreateProjectDirectoryInput {
  parentPath: string;
  name: string;
  /** Written to README.md in the first commit. */
  title?: string;
  description?: string | null;
}

export interface CreateProjectDirectoryResult {
  directoryPath: string;
  project: PersistedProjectRecord;
}

interface ProjectDirectoryFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  /** Creates missing parents too. */
  mkdirp(path: string): Promise<void>;
  /** Creates exactly this directory; fails with EEXIST when it exists. */
  mkdir(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
}

interface CreateProjectDirectoryDependencies {
  filesystem?: ProjectDirectoryFileSystem;
  initializeRepository?: (directoryPath: string, readme: string) => Promise<void>;
  registerProject(directoryPath: string): Promise<PersistedProjectRecord>;
}

const nodeProjectDirectoryFileSystem: ProjectDirectoryFileSystem = {
  stat,
  async mkdirp(path) {
    await mkdir(path, { recursive: true });
  },
  async mkdir(path) {
    await mkdir(path);
  },
  async removeTree(path) {
    await rm(path, { recursive: true, force: true });
  },
};

/**
 * Make a directory a git repository with at least one commit, so the project
 * can cut worktrees immediately (an empty repository has nothing to branch
 * from). No-op when it already is a repository. Writes the README only when
 * none exists, and commits only the README — other files stay untracked.
 * Uses the host's git identity, or a Paseo identity when the host has none.
 */
export async function ensureGitRepository(directoryPath: string, readme: string): Promise<void> {
  try {
    await stat(join(directoryPath, ".git"));
    return;
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  await runGitCommand(["init", "--initial-branch=main"], { cwd: directoryPath });
  try {
    await writeFile(join(directoryPath, "README.md"), readme, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
  }
  await runGitCommand(["add", "README.md"], { cwd: directoryPath });
  const identity = await runGitCommand(["config", "user.email"], {
    cwd: directoryPath,
    acceptExitCodes: [0, 1],
  });
  const fallbackIdentity =
    identity.exitCode === 0 && identity.stdout.trim()
      ? []
      : ["-c", "user.name=Paseo", "-c", "user.email=paseo@localhost"];
  await runGitCommand([...fallbackIdentity, "commit", "-m", "Initial commit"], {
    cwd: directoryPath,
  });
}

export function buildProjectReadme(title: string, description?: string | null): string {
  const body = description?.trim();
  return `# ${title.trim()}\n${body ? `\n${body}\n` : ""}`;
}

export async function createProjectDirectory(
  input: CreateProjectDirectoryInput,
  dependencies: CreateProjectDirectoryDependencies,
): Promise<CreateProjectDirectoryResult> {
  validateDirectoryName(input.name);

  const requestedParentPath = input.parentPath.trim();
  if (!requestedParentPath) {
    throw new ProjectDirectoryRequestError(
      "parent_directory_not_found",
      "Parent directory is required",
    );
  }
  const parentDirectory = resolve(expandTilde(requestedParentPath));
  const directoryPath = resolve(parentDirectory, input.name);
  if (!isPathInside(parentDirectory, directoryPath)) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name must resolve inside the selected parent",
    );
  }

  const filesystem = dependencies.filesystem ?? nodeProjectDirectoryFileSystem;
  await ensureParent(filesystem, parentDirectory);

  try {
    await filesystem.mkdir(directoryPath);
  } catch (error) {
    throw mapCreateDirectoryError(error, directoryPath);
  }

  try {
    const readme = buildProjectReadme(input.title?.trim() || input.name, input.description);
    await (dependencies.initializeRepository ?? ensureGitRepository)(directoryPath, readme);
    const project = await dependencies.registerProject(directoryPath);
    return { directoryPath, project };
  } catch (setupError) {
    try {
      await filesystem.removeTree(directoryPath);
    } catch (rollbackError) {
      throw new ProjectDirectoryRequestError(
        "registration_failed",
        `Failed to create project and roll back directory: ${errorMessage(rollbackError)}`,
        directoryPath,
      );
    }
    throw new ProjectDirectoryRequestError(
      "registration_failed",
      `Failed to create project: ${errorMessage(setupError)}`,
      directoryPath,
    );
  }
}

export function validateDirectoryName(name: string): void {
  if (name.trim().length === 0) {
    throw new ProjectDirectoryRequestError("invalid_name", "Directory name cannot be empty");
  }
  if (name !== name.trim()) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name cannot start or end with whitespace",
    );
  }
  if (name === "." || name === "..") {
    throw new ProjectDirectoryRequestError("invalid_name", "Directory name cannot be . or ..");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name must be a single name without path separators",
    );
  }
  if (isAbsolute(name) || win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new ProjectDirectoryRequestError(
      "invalid_name",
      "Directory name cannot be an absolute path",
    );
  }
}

async function ensureParent(
  filesystem: ProjectDirectoryFileSystem,
  parentDirectory: string,
): Promise<void> {
  try {
    await filesystem.mkdirp(parentDirectory);
    const parent = await filesystem.stat(parentDirectory);
    if (parent.isDirectory()) {
      return;
    }
    throw new ProjectDirectoryRequestError(
      "parent_directory_not_found",
      `Parent path is not a directory: ${parentDirectory}`,
    );
  } catch (error) {
    if (error instanceof ProjectDirectoryRequestError) {
      throw error;
    }
    const code = nodeErrorCode(error);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new ProjectDirectoryRequestError(
        "permission_denied",
        `Permission denied creating parent directory: ${parentDirectory}`,
      );
    }
    if (code === "ENOTDIR" || code === "EEXIST") {
      throw new ProjectDirectoryRequestError(
        "parent_directory_not_found",
        `Parent path is not a directory: ${parentDirectory}`,
      );
    }
    throw new ProjectDirectoryRequestError(
      "filesystem_error",
      `Failed to create parent directory: ${errorMessage(error)}`,
    );
  }
}

function mapCreateDirectoryError(
  error: unknown,
  directoryPath: string,
): ProjectDirectoryRequestError {
  const code = nodeErrorCode(error);
  if (code === "EEXIST") {
    return new ProjectDirectoryRequestError(
      "directory_exists",
      `Directory already exists: ${directoryPath}`,
      directoryPath,
    );
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ProjectDirectoryRequestError(
      "parent_directory_not_found",
      `Parent directory not found: ${resolve(directoryPath, "..")}`,
      directoryPath,
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new ProjectDirectoryRequestError(
      "permission_denied",
      `Permission denied creating directory: ${directoryPath}`,
      directoryPath,
    );
  }
  return new ProjectDirectoryRequestError(
    "filesystem_error",
    `Failed to create directory: ${errorMessage(error)}`,
    directoryPath,
  );
}

function isPathInside(parentDirectory: string, directoryPath: string): boolean {
  const relativePath = relative(parentDirectory, directoryPath);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function nodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
