import { resolve, basename } from "node:path";
import { runGitCommand } from "./run-git-command.js";

export interface SubmoduleInfo {
  path: string;
  name: string;
  status: "clean" | "dirty" | "uninitialized";
  headRef: string | null;
  children: SubmoduleInfo[];
}

export async function discoverSubmodules(repoRoot: string): Promise<SubmoduleInfo[]> {
  // Get all submodules recursively
  const result = await runGitCommand(["submodule", "status", "--recursive"], {
    cwd: repoRoot,
    timeout: 15_000,
  });

  if (!result.stdout.trim()) {
    return [];
  }

  // Parse git submodule status output
  // Format: " <sha> <path> (<describe>)" or "+<sha> <path> (<describe>)" (dirty) or "-<sha> <path>" (uninitialized)
  const entries: { path: string; status: "clean" | "dirty" | "uninitialized" }[] = [];

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;

    const prefix = line.charAt(0);
    // After the optional prefix char and SHA, the path follows
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

  // For each entry, get the current branch and refine dirty status
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
          // ignore — submodule might not be initialized
        }

        // Also check if there are uncommitted changes (more accurate than the +/- prefix)
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

      return {
        path: entry.path,
        name: basename(entry.path),
        status: entry.status,
        headRef,
      };
    }),
  );

  // Build tree from flat list
  return buildSubmoduleTree(enriched);
}

interface FlatSubmodule {
  path: string;
  name: string;
  status: "clean" | "dirty" | "uninitialized";
  headRef: string | null;
}

function buildSubmoduleTree(flat: FlatSubmodule[]): SubmoduleInfo[] {
  // Sort by path depth so parents come before children
  const sorted = [...flat].sort((a, b) => a.path.split("/").length - b.path.split("/").length);

  const root: SubmoduleInfo[] = [];
  const byPath = new Map<string, SubmoduleInfo>();

  for (const entry of sorted) {
    const node: SubmoduleInfo = { ...entry, children: [] };
    byPath.set(entry.path, node);

    // Find parent: walk up the path to find the nearest ancestor that is a submodule
    let placed = false;
    const parts = entry.path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const parentPath = parts.slice(0, i).join("/");
      const parent = byPath.get(parentPath);
      if (parent) {
        parent.children.push(node);
        placed = true;
        break;
      }
    }

    if (!placed) {
      root.push(node);
    }
  }

  return root;
}
