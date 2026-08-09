import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import { resolveWorkspaceChipLabel, workspaceChip } from "./proposal-card-chips";

const CHIP_TEMPLATES: Record<string, string> = {
  "missionControl.proposal.chips.project": "Project: {{label}}",
  "missionControl.proposal.chips.workspace": "Workspace: {{label}}",
  "missionControl.proposal.chips.agent": "Agent: {{label}}",
  "missionControl.proposal.chips.newProject": "New project: {{label}}",
  "missionControl.proposal.chips.newWorkspace": "New workspace: {{label}}",
  "missionControl.proposal.chips.newAgent": "New agent: {{label}}",
};
const t = ((key: string, opts?: Record<string, string>) =>
  (CHIP_TEMPLATES[key] ?? key).replace("{{label}}", opts?.label ?? "")) as TFunction;

function spawnProposal(overrides: {
  workspaceId?: string;
  workspaceLabel?: string;
  newWorkspace?: string;
}): MissionControlProposal {
  return {
    id: "mcp_1",
    createdAt: "2026-08-09T00:00:00.000Z",
    origin: "commander",
    serverId: "srv_1",
    targetAgentId: "",
    message: "Spawn test agent",
    deliveryMode: "interrupt",
    reason: "Commander spawn",
    classification: "normal",
    kind: "spawn",
    status: "pending",
    spawnPlan: {
      host: "macbook",
      provider: "omp/opencode-zen/deepseek-v4-flash-free",
      summary: "Spawn test agent",
      ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
      ...(overrides.workspaceLabel ? { labels: { workspace: overrides.workspaceLabel } } : {}),
      ...(overrides.newWorkspace ? { labels: { newWorkspace: overrides.newWorkspace } } : {}),
    },
  };
}

describe("resolveWorkspaceChipLabel", () => {
  it("resolves an opaque workspace id to its session-store title", () => {
    const title = resolveWorkspaceChipLabel("wks_bd8851728e2f2a7d", (id) =>
      id === "wks_bd8851728e2f2a7d" ? "Learning LLM" : undefined,
    );
    expect(title).toBe("Learning LLM");
  });

  it("falls back to the workspace name when no title is known", () => {
    const label = resolveWorkspaceChipLabel("wks_bd8851728e2f2a7d", () => "learning-llm");
    expect(label).toBe("learning-llm");
  });

  it("falls back to a shortened id only when the workspace is unknown", () => {
    const label = resolveWorkspaceChipLabel("wks_bd8851728e2f2a7d", () => undefined);
    expect(label).toBe("wks_bd8851728e2f…");
    expect(label.length).toBeLessThan("wks_bd8851728e2f2a7d".length);
  });

  it("passes a resolved label slot through untouched (already a title)", () => {
    const label = resolveWorkspaceChipLabel("Learning LLM", () => "ignored");
    expect(label).toBe("Learning LLM");
  });
});

describe("workspaceChip", () => {
  it("shows the workspace title resolved from the session store, not the raw id", () => {
    const chip = workspaceChip(
      spawnProposal({ workspaceId: "wks_bd8851728e2f2a7d" }),
      t,
      () => "Learning LLM",
    );
    expect(chip).toEqual({ key: "workspace", label: "Workspace: Learning LLM" });
  });

  it("falls back to a shortened id when the workspace is unknown", () => {
    const chip = workspaceChip(spawnProposal({ workspaceId: "wks_bd8851728e2f2a7d" }), t);
    expect(chip?.label).toBe("Workspace: wks_bd8851728e2f…");
  });

  it("prefers a label-slot title over the id", () => {
    const chip = workspaceChip(
      spawnProposal({ workspaceId: "wks_bd8851728e2f2a7d", workspaceLabel: "Learning LLM" }),
      t,
    );
    expect(chip?.label).toBe("Workspace: Learning LLM");
  });

  it("renders a new-workspace chip from the proposed name", () => {
    const chip = workspaceChip(spawnProposal({ newWorkspace: "Fresh experiments" }), t);
    expect(chip).toEqual({ key: "newWorkspace", label: "New workspace: Fresh experiments" });
  });

  it("returns null when the proposal carries no workspace", () => {
    expect(workspaceChip(spawnProposal({}), t)).toBeNull();
  });
});
