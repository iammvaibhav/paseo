import type { TFunction } from "i18next";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";

/**
 * Pure plan-chip resolution for proposal cards. Kept free of component imports
 * so the label logic is unit-testable without mounting the unistyles chain.
 */

export interface ChipInfo {
  key: string;
  label: string;
}

/** Resolves a workspace id to its display title from the session store. */
export type WorkspaceTitleResolver = (workspaceId: string) => string | undefined;

/**
 * Resolve the workspace chip label: an opaque `wks_*` id is looked up in the
 * session store (title, then name) and falls back to a shortened id only when
 * unknown; anything else (a resolved label slot / new-workspace name) is
 * already a title and passes through untouched.
 */
export function resolveWorkspaceChipLabel(
  rawWorkspace: string,
  resolveWorkspaceTitle?: WorkspaceTitleResolver,
): string {
  if (!rawWorkspace.startsWith("wks_")) {
    return rawWorkspace;
  }
  const title = resolveWorkspaceTitle?.(rawWorkspace);
  if (title) {
    return title;
  }
  return rawWorkspace.length > 16 ? `${rawWorkspace.slice(0, 16)}…` : rawWorkspace;
}

/** Reads a spawnPlan field from its labels slot or the legacy flat field. */
export function rawSpawnField(
  spawnPlan: MissionControlProposal["spawnPlan"],
  labels: Record<string, string> | undefined,
  field: string,
): string | undefined {
  return (
    labels?.[field] ??
    ((spawnPlan as Record<string, unknown> | undefined)?.[field] as string | undefined)
  );
}

/** Chip for the project the spawn targets, or the project it would create. */
export function projectChip(proposal: MissionControlProposal, t: TFunction): ChipInfo | null {
  const spawnPlan = proposal.spawnPlan;
  const labels = spawnPlan?.labels;
  const rawProject = rawSpawnField(spawnPlan, labels, "project");
  const rawNewProject = rawSpawnField(spawnPlan, labels, "newProject");
  if (rawNewProject) {
    return {
      key: "newProject",
      label: t("missionControl.proposal.chips.newProject", { label: rawNewProject }),
    };
  }
  if (rawProject) {
    return {
      key: "project",
      label: t("missionControl.proposal.chips.project", { label: rawProject }),
    };
  }
  return null;
}

/** Chip for the workspace the spawn targets, or the one it would create. */
export function workspaceChip(
  proposal: MissionControlProposal,
  t: TFunction,
  resolveWorkspaceTitle?: WorkspaceTitleResolver,
): ChipInfo | null {
  const spawnPlan = proposal.spawnPlan;
  const labels = spawnPlan?.labels;
  const rawWorkspace =
    labels?.workspace ?? spawnPlan?.workspaceId ?? rawSpawnField(spawnPlan, labels, "workspace");
  const rawNewWorkspace = rawSpawnField(spawnPlan, labels, "newWorkspace");
  if (rawNewWorkspace) {
    return {
      key: "newWorkspace",
      label: t("missionControl.proposal.chips.newWorkspace", { label: rawNewWorkspace }),
    };
  }
  if (rawWorkspace) {
    return {
      key: "workspace",
      label: t("missionControl.proposal.chips.workspace", {
        label: resolveWorkspaceChipLabel(rawWorkspace, resolveWorkspaceTitle),
      }),
    };
  }
  return null;
}

/** Chip for the agent the proposal targets, or the agent it would spawn. */
export function agentChip(proposal: MissionControlProposal, t: TFunction): ChipInfo | null {
  const spawnPlan = proposal.spawnPlan;
  const labels = spawnPlan?.labels;
  const rawAgent = spawnPlan?.title ?? labels?.agent ?? rawSpawnField(spawnPlan, labels, "agent");
  const rawNewAgent = rawSpawnField(spawnPlan, labels, "newAgent");
  if (rawNewAgent) {
    return {
      key: "newAgent",
      label: t("missionControl.proposal.chips.newAgent", { label: rawNewAgent }),
    };
  }
  if (rawAgent) {
    const isSpawn = proposal.kind === "spawn";
    return {
      key: isSpawn ? "newAgent" : "agent",
      label: isSpawn
        ? t("missionControl.proposal.chips.newAgent", { label: rawAgent })
        : t("missionControl.proposal.chips.agent", { label: rawAgent }),
    };
  }
  return null;
}

export function resolvePlanChips(
  proposal: MissionControlProposal,
  t: TFunction,
  resolveWorkspaceTitle?: WorkspaceTitleResolver,
): ChipInfo[] {
  const chips: ChipInfo[] = [];
  const project = projectChip(proposal, t);
  if (project) {
    chips.push(project);
  }
  const workspace = workspaceChip(proposal, t, resolveWorkspaceTitle);
  if (workspace) {
    chips.push(workspace);
  }
  const agent = agentChip(proposal, t);
  if (agent) {
    chips.push(agent);
  }
  return chips;
}
