// COMPAT(projectRootCanonicalization): one-time repair, delete after 2027-04-13
// once every daemon has booted a release that canonicalizes project roots.
//
// Project roots used to be matched lexically, so one directory reached through a
// symlink (~/paseo -> /data/paseo) could be registered as two active projects.
// Registration now canonicalizes with realpath; this migration folds the
// duplicates already on disk into one project per canonical root. It runs at
// every startup and is a no-op once no two active projects share a root.
import type { Logger } from "pino";

import type { AgentStorage } from "../agent/agent-storage.js";
import { canonicalizePath } from "../../utils/path.js";
import type {
  PersistedProjectRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";

export interface MergedProjectGroup {
  projectId: string;
  mergedProjectIds: string[];
}

export async function dedupeEquivalentProjectRoots(options: {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  agentStorage: Pick<AgentStorage, "listByWorkspace" | "upsert">;
  logger: Logger;
  now?: () => string;
}): Promise<MergedProjectGroup[]> {
  const groups = new Map<string, PersistedProjectRecord[]>();
  for (const project of await options.projectRegistry.list()) {
    if (project.archivedAt) continue;
    const root = canonicalizePath(project.rootPath);
    groups.set(root, [...(groups.get(root) ?? []), project]);
  }

  const merged: MergedProjectGroup[] = [];
  for (const [canonicalRoot, projects] of groups) {
    if (projects.length < 2) continue;
    // The oldest record is the one clients, tickets and run records have
    // referenced longest, so its id survives.
    const [survivor, ...duplicates] = projects.toSorted(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.projectId.localeCompare(right.projectId),
    );
    const timestamp = options.now?.() ?? new Date().toISOString();
    await mergeDuplicates({ ...options, survivor, duplicates, canonicalRoot, timestamp });
    const mergedProjectIds = duplicates.map((project) => project.projectId);
    options.logger.info(
      { projectId: survivor.projectId, mergedProjectIds, rootPath: canonicalRoot },
      "Merged projects registered under equivalent root paths",
    );
    merged.push({ projectId: survivor.projectId, mergedProjectIds });
  }
  return merged;
}

async function mergeDuplicates(input: {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  agentStorage: Pick<AgentStorage, "listByWorkspace" | "upsert">;
  survivor: PersistedProjectRecord;
  duplicates: PersistedProjectRecord[];
  canonicalRoot: string;
  timestamp: string;
}): Promise<void> {
  const { survivor, duplicates, timestamp } = input;
  const workspaces = await input.workspaceRegistry.list();
  const survivorBase = workspaces.find(
    (workspace) => workspace.workspaceId === survivor.baseWorkspaceId && !workspace.archivedAt,
  );
  // Without a live base of its own, the survivor adopts a duplicate's.
  const baseWorkspaceId =
    survivorBase?.workspaceId ??
    workspaces.find(
      (workspace) =>
        !workspace.archivedAt &&
        duplicates.some((duplicate) => duplicate.baseWorkspaceId === workspace.workspaceId),
    )?.workspaceId ??
    null;

  for (const duplicate of duplicates) {
    for (const workspace of workspaces) {
      if (workspace.projectId !== duplicate.projectId) continue;
      // Both projects got a base workspace over the same root checkout; keep
      // the survivor's and hand it the duplicate's agents.
      const isRedundantBase =
        workspace.workspaceId === duplicate.baseWorkspaceId &&
        !workspace.archivedAt &&
        survivorBase !== undefined &&
        canonicalizePath(workspace.cwd) === canonicalizePath(survivorBase.cwd);
      if (isRedundantBase) {
        for (const agent of await input.agentStorage.listByWorkspace(workspace.workspaceId)) {
          await input.agentStorage.upsert({ ...agent, workspaceId: survivorBase.workspaceId });
        }
      }
      // upsert, not archive(): the archive mutation fires workspace.archived
      // plugin hooks, and this checkout is still in use.
      await input.workspaceRegistry.upsert({
        ...workspace,
        projectId: survivor.projectId,
        ...(isRedundantBase ? { archivedAt: timestamp, updatedAt: timestamp } : {}),
      });
    }
    await input.projectRegistry.archive(duplicate.projectId, timestamp);
  }

  await input.projectRegistry.upsert({
    ...survivor,
    rootPath: input.canonicalRoot,
    customName: survivor.customName ?? duplicates.find((p) => p.customName)?.customName ?? null,
    description: survivor.description ?? duplicates.find((p) => p.description)?.description ?? null,
    baseWorkspaceId,
    updatedAt: timestamp,
  });
}
