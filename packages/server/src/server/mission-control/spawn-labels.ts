import { basename, resolve as resolvePath } from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { areEquivalentPaths } from "../../utils/path.js";
import { resolveWorkspaceIdForPath } from "../resolve-workspace-id-for-path.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import { deriveWorkspaceDisplayName } from "../workspace-registry-model.js";
import {
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";

/**
 * Read-only spawn-label resolution: human-readable workspace/project names for
 * a Commander spawn proposal card. The card's project/workspace chips render
 * from `spawnPlan.labels` — the payload must be self-contained because the
 * client's session-store lookup cannot see a peer host's workspaces.
 *
 * The resolver runs on the host the spawn TARGETS: the local fleet_create_agent
 * branch and the `mission_control.spawn_labels.resolve` peer RPC handler both
 * call {@link resolveLocalSpawnLabels} with their own registries, so a spawn
 * into a new workspace on a peer shows the same exact name the provisioning
 * path would mint there (branch when on one, else the cwd's last path
 * segment) instead of nothing.
 */
export interface SpawnLabelsDependencies {
  workspaceRegistry?: Pick<WorkspaceRegistry, "list" | "get">;
  projectRegistry?: Pick<ProjectRegistry, "list" | "get">;
  workspaceGitService?: Pick<WorkspaceGitService, "getCheckout">;
  logger?: Logger;
}

export interface ResolveSpawnLabelsInput {
  cwd?: string;
  workspaceId?: string;
}

/**
 * The name a freshly minted workspace at `cwd` would get, mirroring the
 * provisioning path (createWorkspaceForDirectory → initialWorkspacePlacement
 * → deriveWorkspaceDisplayName → resolveWorkspaceName): the checked-out
 * branch when on one, else the cwd's last path segment. When the cwd
 * already maps to a known workspace, that workspace's real name (title
 * wins) is preferred — the fresh mint shares the same checkout facts.
 */
async function resolveNewWorkspaceDisplayName(
  deps: SpawnLabelsDependencies,
  cwd: string,
): Promise<string> {
  if (deps.workspaceRegistry) {
    const mapped = resolveWorkspaceIdForPath(cwd, await deps.workspaceRegistry.list());
    if (mapped) {
      const workspace = await deps.workspaceRegistry.get(mapped);
      if (workspace && !workspace.archivedAt) {
        return resolveWorkspaceDisplayName(workspace);
      }
    }
  }
  // Best-effort checkout read; never fails label resolution.
  let checkout: ProjectCheckoutLitePayload | undefined;
  try {
    checkout = await deps.workspaceGitService?.getCheckout(cwd);
  } catch (error) {
    deps.logger?.warn?.({ err: error, cwd }, "Failed to read checkout for a spawn proposal label");
  }
  if (checkout) {
    // Same derivation the provisioning path uses (branch when on one, else
    // the cwd's last path segment — deriveWorkspaceDisplayName's fallback).
    return deriveWorkspaceDisplayName({ cwd, checkout });
  }
  const segments = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}

/**
 * The project a freshly minted workspace at `cwd` would join, mirroring the
 * provisioning path (findOrCreateProjectForDirectory → getOrCreateActiveByRoot):
 * an active project at the exact cwd root is reused when present (existing
 * `project` label, custom name wins), otherwise a project named after the
 * cwd's basename would be created (`newProject` label). Read-only — unlike
 * getOrCreateActiveByRoot this never registers a record; a denied proposal
 * must not leave a project behind.
 */
async function resolveNewWorkspaceProjectLabel(
  deps: SpawnLabelsDependencies,
  cwd: string,
): Promise<{ key: "project" | "newProject"; name: string }> {
  const rootPath = resolvePath(cwd);
  if (deps.workspaceRegistry && deps.projectRegistry) {
    const mapped = resolveWorkspaceIdForPath(cwd, await deps.workspaceRegistry.list());
    if (mapped) {
      const workspace = await deps.workspaceRegistry.get(mapped);
      // Only an exact cwd match reuses the mapped project — find-or-create
      // keys on the root path, so a nested cwd would mint its own project.
      if (workspace && !workspace.archivedAt && resolvePath(workspace.cwd) === rootPath) {
        const project = await deps.projectRegistry.get(workspace.projectId);
        if (project && !project.archivedAt) {
          return { key: "project", name: resolveProjectDisplayName(project) };
        }
      }
    }
    // A pre-created project at the root (e.g. fleet_meta create_project) is
    // what the provisioning path would reuse — name the card after it.
    const projects = await deps.projectRegistry.list();
    const existing = projects.find(
      (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, rootPath),
    );
    if (existing) {
      return { key: "project", name: resolveProjectDisplayName(existing) };
    }
  }
  return { key: "newProject", name: basename(rootPath) || cwd };
}

/**
 * Resolve human-readable workspace/project labels for a Commander spawn
 * proposal at proposal-creation time, so the card renders names instead of
 * raw `wks_…` ids — even when the target workspace lives on another host
 * (the client's session-store lookup cannot see a peer's workspaces, so the
 * payload must be self-contained).
 *
 * Existing workspace (`workspaceId`): the workspace display name and its
 * project's name. New workspace (cwd only): the name the minted workspace
 * would get (see resolveNewWorkspaceDisplayName) plus the project it would
 * join. Labels are never fabricated: when nothing resolves, the label is
 * left absent and the chips fall back to the raw payload fields.
 */
export async function resolveLocalSpawnLabels(
  deps: SpawnLabelsDependencies,
  input: ResolveSpawnLabelsInput,
): Promise<Record<string, string> | undefined> {
  const { cwd, workspaceId } = input;
  const labels: Record<string, string> = {};
  if (workspaceId) {
    const workspace = deps.workspaceRegistry
      ? await deps.workspaceRegistry.get(workspaceId)
      : undefined;
    if (workspace && !workspace.archivedAt) {
      labels.workspace = resolveWorkspaceDisplayName(workspace);
      const project = deps.projectRegistry
        ? await deps.projectRegistry.get(workspace.projectId)
        : undefined;
      if (project && !project.archivedAt) {
        labels.project = resolveProjectDisplayName(project);
      }
    }
  } else if (cwd) {
    labels.newWorkspace = await resolveNewWorkspaceDisplayName(deps, cwd);
    const projectLabel = await resolveNewWorkspaceProjectLabel(deps, cwd);
    labels[projectLabel.key] = projectLabel.name;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}
