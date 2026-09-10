import { resolve, basename } from "node:path";
import { runGitCommand } from "./run-git-command.js";

export interface SubmoduleEntry {
  path: string;
  name: string;
  status: "clean" | "dirty" | "uninitialized";
  headRef: string | null;
  parentPath: string | null;
}

export async function discoverSubmodules(repoRoot: string): Promise<SubmoduleEntry[]> {
  const result = await runGitCommand(["submodule", "status", "--recursive"], {
    cwd: repoRoot,
    timeout: 15_000,
  });

  if (!result.stdout.trim()) {
    return [];
  }

  const entries: { path: string; status: "clean" | "dirty" | "uninitialized" }[] = [];

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;

    const prefix = line.charAt(0);
    const match = /^[+ -]([0-9a-f]+) (.+?)(?:\s+\(.*\))?$/.exec(line);
    if (!match) continue;

    const subPath = match[2].trim();
    let status: "clean" | "dirty" | "uninitialized";
    if (prefix === "-") {
      status = "uninitialized";
    } else if (prefix === "+") {
      status = "dirty";
    } else {
      status = "clean";
    }

    entries.push({ path: subPath, status });
  }

  const allPaths = new Set(entries.map((e) => e.path));

  const enriched = await Promise.all(
    entries.map(async (entry) => {
      const absPath = resolve(repoRoot, entry.path);
      let headRef: string | null = null;

      if (entry.status !== "uninitialized") {
        try {
          const branchResult = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: absPath,
            timeout: 5_000,
          });
          const ref = branchResult.stdout.trim();
          headRef = ref === "HEAD" ? null : ref;
        } catch {
          // ignore
        }

        if (entry.status === "clean") {
          try {
            const statusResult = await runGitCommand(["status", "--porcelain"], {
              cwd: absPath,
              timeout: 5_000,
            });
            if (statusResult.stdout.trim().length > 0) {
              entry.status = "dirty";
            }
          } catch {
            // ignore
          }
        }
      }

      const parentPath = findParentSubmodule(entry.path, allPaths);

      return {
        path: entry.path,
        name: basename(entry.path),
        status: entry.status,
        headRef,
        parentPath,
      };
    }),
  );

  return enriched;
}

function findParentSubmodule(subPath: string, allPaths: Set<string>): string | null {
  const parts = subPath.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join("/");
    if (allPaths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}
