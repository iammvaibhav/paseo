import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import { resolveWorkspaceChipLabel, workspaceChip } from "./proposal-card-chips";
import {
  deriveProposalCardIdentity,
  nonOpaqueMetaTargetLabel,
  opaqueAgentId,
  resolveAgentIdentityAcrossSessions,
  resolveOpaqueAgentLabel,
  type SessionsIdentitySource,
} from "./proposal-card-identity";

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

const UUID_A = "442c01b4-25ff-42f8-9e6b-0dbd722d2611";
const UUID_B = "d7050531-e19d-4ac3-8593-4ebcd8400692";

function sessions(overrides?: Partial<SessionsIdentitySource>): SessionsIdentitySource {
  return {
    alpha: {
      agents: new Map([[UUID_A, { name: "Aero", title: "Worker" }]]),
      agentDetails: new Map(),
    },
    beta: {
      agents: new Map(),
      agentDetails: new Map([[UUID_B, { name: "Peer Worker", title: "Beta worker" }]]),
    },
    ...overrides,
  };
}

function proposal(overrides: Partial<MissionControlProposal> = {}): MissionControlProposal {
  return {
    id: "mcp_1",
    createdAt: "2026-08-09T00:00:00.000Z",
    origin: "commander",
    serverId: "alpha",
    targetAgentId: UUID_A,
    message: "Proposal message",
    deliveryMode: "interrupt",
    reason: "Test",
    classification: "normal",
    status: "pending",
    ...overrides,
  };
}

describe("opaqueAgentId", () => {
  it("treats a raw UUID as opaque", () => {
    expect(opaqueAgentId(UUID_A, [UUID_A])).toBe(UUID_A);
  });

  it("treats an exact known-id match as opaque even when not UUID-shaped", () => {
    expect(opaqueAgentId("worker-1", ["worker-1"])).toBe("worker-1");
  });

  it("treats `Verifier · <id>` as opaque and returns the subject id", () => {
    expect(opaqueAgentId(`Verifier · ${UUID_A}`, [UUID_A])).toBe(UUID_A);
    expect(opaqueAgentId(`Verifier · ${UUID_A}`, [])).toBe(UUID_A);
  });

  it("passes readable labels through (null)", () => {
    expect(opaqueAgentId("Verifier · Aero", [UUID_A])).toBeNull();
    expect(opaqueAgentId("Aero", [UUID_A])).toBeNull();
    expect(opaqueAgentId("Repair mission control cards", [UUID_A])).toBeNull();
  });
});

describe("resolveAgentIdentityAcrossSessions", () => {
  it("finds a live agent in its own host session", () => {
    const identity = resolveAgentIdentityAcrossSessions(sessions(), UUID_A);
    expect(identity?.name).toBe("Aero");
  });

  it("finds an archived agent in another host's agentDetails (peer resolution)", () => {
    const identity = resolveAgentIdentityAcrossSessions(sessions(), UUID_B);
    expect(identity?.name).toBe("Peer Worker");
  });

  it("returns null for an unknown id", () => {
    expect(resolveAgentIdentityAcrossSessions(sessions(), "unknown-uuid")).toBeNull();
    expect(resolveAgentIdentityAcrossSessions(undefined, UUID_A)).toBeNull();
  });
});

describe("nonOpaqueMetaTargetLabel", () => {
  it("returns the record's own label when present and readable", () => {
    const p = proposal({
      kind: "meta",
      targetAgentId: "",
      metaPlan: { action: "adopt_agent", targetId: UUID_B, targetLabel: "Peer Worker (Eden)" },
    });
    expect(nonOpaqueMetaTargetLabel(p, [UUID_B])).toBe("Peer Worker (Eden)");
  });

  it("returns null when the label is itself opaque", () => {
    const p = proposal({
      kind: "meta",
      targetAgentId: "",
      metaPlan: { action: "adopt_agent", targetId: UUID_B, targetLabel: UUID_B },
    });
    expect(nonOpaqueMetaTargetLabel(p, [UUID_B])).toBeNull();
  });

  it("returns null when absent", () => {
    expect(nonOpaqueMetaTargetLabel(proposal(), [UUID_A])).toBeNull();
  });
});

describe("resolveOpaqueAgentLabel", () => {
  const resolve = (id: string) => resolveAgentIdentityAcrossSessions(sessions(), id);

  it("resolves a raw id to the live name", () => {
    expect(resolveOpaqueAgentLabel(UUID_A, [UUID_A], resolve)).toBe("Aero");
  });

  it("resolves a `Verifier · <id>` label keeping the prefix", () => {
    expect(resolveOpaqueAgentLabel(`Verifier · ${UUID_A}`, [UUID_A], resolve)).toBe(
      "Verifier · Aero",
    );
  });

  it("fails closed to Agent / Verifier when unresolved, never the raw id", () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect(resolveOpaqueAgentLabel(unknown, [], resolve)).toBe("Agent");
    expect(resolveOpaqueAgentLabel(`Verifier · ${unknown}`, [], resolve)).toBe("Verifier");
  });

  it("passes readable labels through (null)", () => {
    expect(resolveOpaqueAgentLabel("Verifier · Aero", [UUID_A], resolve)).toBeNull();
  });
});

describe("deriveProposalCardIdentity", () => {
  it("resolves an opaque UUID title to the fleet name across hosts", () => {
    const { title, agentChipLabel } = deriveProposalCardIdentity(
      { agentId: UUID_B, agentTitle: UUID_B },
      proposal({ targetAgentId: UUID_B }),
      sessions(),
      false,
    );
    expect(title).toBe("Peer Worker");
    expect(agentChipLabel).toBe("Peer Worker");
  });

  it("resolves `Verifier · <id>` titles to the alias, keeping the prefix", () => {
    const { title } = deriveProposalCardIdentity(
      { agentId: UUID_A, agentTitle: `Verifier · ${UUID_A}` },
      proposal({ origin: "verifier", targetAgentId: UUID_A }),
      sessions(),
      false,
    );
    expect(title).toBe("Verifier · Aero");
  });

  it("fails closed to neutral labels when unresolved, never a raw UUID", () => {
    const plain = deriveProposalCardIdentity(
      { agentId: "unknown-uuid", agentTitle: "unknown-uuid" },
      proposal({ targetAgentId: "unknown-uuid" }),
      {},
      false,
    );
    expect(plain.title).toBe("Agent");
    expect(plain.agentChipLabel).toBe("Agent");

    const verifier = deriveProposalCardIdentity(
      { agentId: "unknown-uuid", agentTitle: "Verifier · unknown-uuid" },
      proposal({ origin: "verifier", targetAgentId: "unknown-uuid" }),
      {},
      false,
    );
    expect(verifier.title).toBe("Verifier");
  });

  it("prefers the record's non-opaque metaPlan.targetLabel before session lookup", () => {
    const { title, agentChipLabel } = deriveProposalCardIdentity(
      { agentId: UUID_B, agentTitle: UUID_B },
      proposal({
        targetAgentId: UUID_B,
        kind: "meta",
        metaPlan: { action: "adopt_agent", targetId: UUID_B, targetLabel: "Peer Worker (Eden)" },
      }),
      // The peer session does NOT hold the id — the label still wins.
      { alpha: { agents: new Map(), agentDetails: new Map() } },
      false,
    );
    expect(title).toBe("Peer Worker (Eden)");
    expect(agentChipLabel).toBe("Peer Worker (Eden)");
  });

  it("keeps a readable stored title untouched (frozen snapshot copy)", () => {
    const { title, agentChipLabel } = deriveProposalCardIdentity(
      { agentId: UUID_A, agentTitle: "Aero" },
      proposal({ targetAgentId: UUID_A }),
      sessions(),
      false,
    );
    expect(title).toBe("Aero");
    // The chip still prefers the live name.
    expect(agentChipLabel).toBe("Aero");
  });

  it("keeps the frozen title on the chip when agent names are hidden", () => {
    const { agentChipLabel } = deriveProposalCardIdentity(
      { agentId: UUID_A, agentTitle: "Aero" },
      proposal({ targetAgentId: UUID_A }),
      sessions(),
      true,
    );
    expect(agentChipLabel).toBe("Aero");
  });
});
