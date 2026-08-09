import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { MissionControlProposal } from "@getpaseo/protocol/mission-control/types";
import {
  MissionControlApprovals,
  ProposalDeliveryAborted,
  PROPOSAL_TTL_MS,
  type MissionControlApprovalsOptions,
  type ProposalCreateInput,
} from "./approvals.js";
import type { MissionControlPresenceSource } from "./presence.js";
import { MissionControlStore } from "./store.js";

/** Drain the store's fire-and-forget write tails so temp dirs can be removed. */
async function awaitStoreWrites(store: MissionControlStore): Promise<void> {
  const internals = store as unknown as {
    appendTail: Promise<void>;
    persistTail: Promise<void>;
  };
  await Promise.all([internals.appendTail, internals.persistTail]);
}

interface Harness {
  dir: string;
  store: MissionControlStore;
  approvals: MissionControlApprovals;
  presence: MissionControlPresenceSource;
  mode: "ask" | "auto";
  delivered: Array<{
    agentId: string;
    message: string;
    deliveryMode: "steer" | "interrupt" | "queue";
    classification?: "machinery" | "instruction";
  }>;
  published: MissionControlProposal[];
  denyRevisions: Array<{ proposalId: string; revision: string }>;
}

async function build(overrides?: {
  mode?: "ask" | "auto";
  focused?: (agentId: string) => boolean;
  stoppedBy?: (agentId: string) => "user" | "machinery" | "system" | null;
  spawn?: MissionControlApprovalsOptions["spawn"];
  applyMeta?: MissionControlApprovalsOptions["applyMeta"];
  deliverDenyRevision?: MissionControlApprovalsOptions["deliverDenyRevision"];
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "mc-approvals-"));
  const store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
  await store.initialize();
  const harness: Harness = {
    dir,
    store,
    approvals: null as unknown as MissionControlApprovals,
    presence: {
      isAgentFocused: overrides?.focused ?? (() => false),
      getStoppedBy: overrides?.stoppedBy ?? (() => null),
    },
    mode: overrides?.mode ?? "ask",
    delivered: [],
    published: [],
    denyRevisions: [],
  };
  harness.approvals = new MissionControlApprovals({
    store,
    presence: harness.presence,
    logger: createTestLogger(),
    getMode: () => harness.mode,
    deliver: async (input) => {
      harness.delivered.push(input);
    },
    ...(overrides?.spawn ? { spawn: overrides.spawn } : {}),
    ...(overrides?.applyMeta ? { applyMeta: overrides.applyMeta } : {}),
    publishProposalEvent: async (proposal) => {
      harness.published.push(proposal);
      return { id: `mce_${harness.published.length}` };
    },
    ...(overrides?.deliverDenyRevision
      ? { deliverDenyRevision: overrides.deliverDenyRevision }
      : {
          deliverDenyRevision: async (input) => {
            harness.denyRevisions.push({ proposalId: input.proposal.id, revision: input.revision });
          },
        }),
  });
  return harness;
}

async function teardown(harness: Harness): Promise<void> {
  await awaitStoreWrites(harness.store);
  await rm(harness.dir, { recursive: true, force: true });
}

const baseInput = (overrides: Partial<ProposalCreateInput> = {}): ProposalCreateInput => ({
  origin: "verifier",
  serverId: "server-1",
  targetAgentId: "worker-1",
  message: "Prove the fix with a failing test.",
  deliveryMode: "steer",
  reason: "Proof demand",
  classification: "normal",
  ...overrides,
});

describe("MissionControlApprovals ask mode", () => {
  test("creates a pending proposal, publishes a card, and does not deliver", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      expect(proposal.status).toBe("pending");
      expect(harness.delivered).toHaveLength(0);
      expect(harness.published.map((p) => p.status)).toEqual(["pending"]);
      expect(harness.approvals.getProposal(proposal.id)).toEqual(proposal);
    } finally {
      await teardown(harness);
    }
  });

  test("approve delivers the original message and flips to sent", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      const result = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(result).toEqual({ ok: true });
      expect(harness.delivered).toEqual([
        {
          agentId: "worker-1",
          message: "Prove the fix with a failing test.",
          deliveryMode: "steer",
          // classify-at-source: non-verboseOnly proposals deliver as visible
          // "instruction" rows on the target's timeline.
          classification: "instruction",
          proposal: expect.objectContaining({ id: expect.any(String) }),
        },
      ]);
      const updated = harness.approvals.getProposal(proposal.id);
      expect(updated?.status).toBe("sent");
      expect(harness.published.map((p) => p.status)).toEqual(["pending", "sent"]);
    } finally {
      await teardown(harness);
    }
  });

  test("approve with editedMessage delivers the rewrite", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
        editedMessage: "Edited: show me the test diff.",
      });
      expect(harness.delivered[0].message).toBe("Edited: show me the test diff.");
      expect(harness.approvals.getProposal(proposal.id)?.message).toBe(
        "Edited: show me the test diff.",
      );
      // Approve-with-rewrite is untouched: no deny-revision delivery.
      expect(harness.denyRevisions).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("deny kills the proposal without delivering", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      await harness.approvals.resolveProposal({ proposalId: proposal.id, action: "deny" });
      expect(harness.delivered).toHaveLength(0);
      // A plain deny (no revision attached) delivers nothing to anyone.
      expect(harness.denyRevisions).toHaveLength(0);
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("denied");
    } finally {
      await teardown(harness);
    }
  });

  test("deny with a revision delivers exactly one deny-revision to the Commander (never silent)", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(
        baseInput({ origin: "commander", targetAgentId: "worker-1" }),
      );
      await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "deny",
        editedMessage: "  Run it on gamma instead, with the summaries saved to /tmp.  ",
      });
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("denied");
      // The denied proposal never reaches the target…
      expect(harness.delivered).toHaveLength(0);
      // …but the attached revision goes back to the Commander, exactly once,
      // trimmed (docs/commander.md: Edit re-proposes).
      expect(harness.denyRevisions).toEqual([
        {
          proposalId: proposal.id,
          revision: "Run it on gamma instead, with the summaries saved to /tmp.",
        },
      ]);
    } finally {
      await teardown(harness);
    }
  });

  test("a deny with only whitespace edits is a plain deny (no revision delivered)", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "deny",
        editedMessage: "   ",
      });
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("denied");
      expect(harness.denyRevisions).toHaveLength(0);
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("a failed deny-revision delivery never fails the deny resolution", async () => {
    const harness = await build({
      mode: "ask",
      deliverDenyRevision: async () => {
        throw new Error("mailbox down");
      },
    });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      const result = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "deny",
        editedMessage: "Run it on gamma instead.",
      });
      // The deny resolves even when the revision delivery fails — the
      // failure is logged, never surfaced as a resolution error.
      expect(result).toEqual({ ok: true });
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("denied");
    } finally {
      await teardown(harness);
    }
  });

  test("resolving a non-pending proposal fails", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      await harness.approvals.resolveProposal({ proposalId: proposal.id, action: "deny" });
      const again = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(again).toMatchObject({ ok: false });
      const missing = await harness.approvals.resolveProposal({
        proposalId: "mcp_nope",
        action: "approve",
      });
      expect(missing).toMatchObject({ ok: false });
    } finally {
      await teardown(harness);
    }
  });

  test("forceSend bypasses the gate in ask mode: recorded sent and delivered, never pending", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(
        baseInput({ origin: "stall", deliveryMode: "steer", forceSend: true }),
      );
      expect(proposal.status).toBe("sent");
      expect(harness.delivered).toEqual([
        {
          agentId: "worker-1",
          message: "Prove the fix with a failing test.",
          deliveryMode: "steer",
          // classify-at-source: non-verboseOnly proposals deliver as visible
          // "instruction" rows on the target's timeline.
          classification: "instruction",
          proposal: expect.objectContaining({ id: expect.any(String) }),
        },
      ]);
      expect(harness.published.map((p) => p.status)).toEqual(["sent"]);
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("sent");
    } finally {
      await teardown(harness);
    }
  });

  test("forceSend wins over presence conflicts that would otherwise force ask", async () => {
    const harness = await build({
      mode: "ask",
      focused: (agentId) => agentId === "worker-1",
      stoppedBy: (agentId) => (agentId === "worker-1" ? "user" : null),
    });
    try {
      const proposal = await harness.approvals.createProposal(
        baseInput({ origin: "stall", forceSend: true }),
      );
      expect(proposal.status).toBe("sent");
      expect(harness.delivered).toHaveLength(1);
    } finally {
      await teardown(harness);
    }
  });

  test("verboseOnly stall nudges deliver as machinery; everything else as instruction", async () => {
    const harness = await build({ mode: "auto" });
    try {
      // The stall status-ask nudge: forceSend + verboseOnly → machinery row on
      // the target's own timeline (auditable, rendered as a muted placeholder).
      // The verboseOnly fallback classifies legacy records without the field.
      await harness.approvals.createProposal(
        baseInput({ origin: "stall", deliveryMode: "steer", forceSend: true, verboseOnly: true }),
      );
      // Verifier proof demand: no verboseOnly → instruction (always visible).
      await harness.approvals.createProposal(baseInput({ origin: "verifier" }));
      expect(harness.delivered.map((d) => d.classification)).toEqual(["machinery", "instruction"]);
    } finally {
      await teardown(harness);
    }
  });

  test("an explicit timelineClassification rides the record and the deliver hook", async () => {
    const harness = await build({ mode: "auto" });
    try {
      await harness.approvals.createProposal(
        baseInput({
          origin: "stall",
          deliveryMode: "steer",
          forceSend: true,
          verboseOnly: true,
          timelineClassification: "machinery",
        }),
      );
      expect(harness.delivered[0].classification).toBe("machinery");
      // The classification is persisted on the proposal record (audit trail).
      expect(harness.approvals.listProposals()[0]?.timelineClassification).toBe("machinery");
    } finally {
      await teardown(harness);
    }
  });

  test("an aborted delivery records the proposal expired, never pending or redelivered", async () => {
    const harness = await build({ mode: "ask" });
    try {
      harness.approvals = new MissionControlApprovals({
        store: harness.store,
        presence: harness.presence,
        logger: createTestLogger(),
        getMode: () => harness.mode,
        deliver: async () => {
          throw new ProposalDeliveryAborted("worker-1", "user_stopped");
        },
        publishProposalEvent: async (proposal) => {
          harness.published.push(proposal);
          return { id: `mce_${harness.published.length}` };
        },
      });
      const proposal = await harness.approvals.createProposal(baseInput({ forceSend: true }));
      expect(proposal.status).toBe("expired");
      expect(harness.delivered).toHaveLength(0);
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("expired");
      expect(harness.published.map((p) => p.status)).toEqual(["expired"]);
    } finally {
      await teardown(harness);
    }
  });

  test("expirePendingForAgent kills every pending proposal for the agent", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const first = await harness.approvals.createProposal(baseInput());
      const second = await harness.approvals.createProposal(
        baseInput({ message: "One more proof." }),
      );
      await harness.approvals.expirePendingForAgent("worker-1");
      expect(harness.approvals.getProposal(first.id)?.status).toBe("expired");
      expect(harness.approvals.getProposal(second.id)?.status).toBe("expired");
      const resolve = await harness.approvals.resolveProposal({
        proposalId: first.id,
        action: "approve",
      });
      expect(resolve).toMatchObject({ ok: false });
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });
});

describe("MissionControlApprovals auto mode", () => {
  test("sends immediately and publishes a sent card", async () => {
    const harness = await build({ mode: "auto" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      expect(proposal.status).toBe("sent");
      expect(harness.delivered).toHaveLength(1);
      expect(harness.published.map((p) => p.status)).toEqual(["sent"]);
    } finally {
      await teardown(harness);
    }
  });

  test("destructive classification always asks, even in auto", async () => {
    const harness = await build({ mode: "auto" });
    try {
      const proposal = await harness.approvals.createProposal(
        baseInput({ classification: "destructive" }),
      );
      expect(proposal.status).toBe("pending");
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("a user viewing the target downgrades auto to ask", async () => {
    const harness = await build({
      mode: "auto",
      focused: (agentId) => agentId === "worker-1",
    });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      expect(proposal.status).toBe("pending");
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("a user-stop on the target's last run downgrades auto to ask", async () => {
    const harness = await build({
      mode: "auto",
      stoppedBy: (agentId) => (agentId === "worker-1" ? "user" : null),
    });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      expect(proposal.status).toBe("pending");
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("a machinery stop does not downgrade auto", async () => {
    const harness = await build({
      mode: "auto",
      stoppedBy: () => "machinery",
    });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      expect(proposal.status).toBe("sent");
    } finally {
      await teardown(harness);
    }
  });
});

describe("MissionControlApprovals allow-pair", () => {
  test("approved allow-pair auto-sends later verifier proposals for the pair in ask mode", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const first = await harness.approvals.createProposal(baseInput());
      expect(first.status).toBe("pending");
      await harness.approvals.resolveProposal({
        proposalId: first.id,
        action: "approve",
        allowPair: true,
      });
      const second = await harness.approvals.createProposal(
        baseInput({ message: "One more proof." }),
      );
      expect(second.status).toBe("sent");
      expect(harness.delivered.map((d) => d.message)).toEqual([
        "Prove the fix with a failing test.",
        "One more proof.",
      ]);
    } finally {
      await teardown(harness);
    }
  });

  test("allow-pair is scoped to the serverId+target pair, not other workers", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const first = await harness.approvals.createProposal(baseInput());
      await harness.approvals.resolveProposal({
        proposalId: first.id,
        action: "approve",
        allowPair: true,
      });
      const other = await harness.approvals.createProposal(
        baseInput({ targetAgentId: "worker-2" }),
      );
      expect(other.status).toBe("pending");
    } finally {
      await teardown(harness);
    }
  });
});

describe("MissionControlApprovals expiry", () => {
  test("lazy expiry marks stale pending proposals expired and publishes a card", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const stale = await harness.approvals.createProposal(baseInput());
      vi.setSystemTime(new Date(Date.now() + PROPOSAL_TTL_MS + 60_000));
      try {
        const next = await harness.approvals.createProposal(baseInput({ message: "Fresh one." }));
        expect(next.status).toBe("pending");
        expect(harness.approvals.getProposal(stale.id)?.status).toBe("expired");
        expect(harness.published.some((p) => p.id === stale.id && p.status === "expired")).toBe(
          true,
        );
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await teardown(harness);
    }
  });

  test("expired proposals cannot be approved", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(baseInput());
      vi.setSystemTime(new Date(Date.now() + PROPOSAL_TTL_MS + 60_000));
      try {
        await harness.approvals.expireStale();
        const result = await harness.approvals.resolveProposal({
          proposalId: proposal.id,
          action: "approve",
        });
        expect(result).toMatchObject({ ok: false });
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await teardown(harness);
    }
  });
});

describe("MissionControlApprovals notifications", () => {
  test("onProposalChange fires for every status change", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const seen: string[] = [];
      harness.approvals.onProposalChange((proposal) => seen.push(proposal.status));
      const proposal = await harness.approvals.createProposal(baseInput());
      await harness.approvals.resolveProposal({ proposalId: proposal.id, action: "approve" });
      expect(seen).toEqual(["pending", "sent"]);
    } finally {
      await teardown(harness);
    }
  });
});

// ============================================================================
// Ask-mode gating per action class (spec: "apart from nudge, everything should
// require my approval in ask mode. Spinning up a new agent as well,
// everything."). The exemptions are TWO separate named checks
// (isForceSendNudge / isAllowPairExempt) and this table pins every action
// class so it cannot drift — both paths asserted separately below.
// ============================================================================

describe("MissionControlApprovals ask-mode gating per action class", () => {
  test("enumerated action classes: nudge exempt, everything else pending in ask mode", async () => {
    const harness = await build({ mode: "ask" });
    try {
      // Each row: what the machinery does → the proposal it creates.
      const actionClasses: Array<{
        label: string;
        input: ProposalCreateInput;
      }> = [
        // The FIRST exemption path: the status-ask nudge (auto-sent, forceSend).
        {
          label: "status-ask nudge",
          input: baseInput({
            origin: "stall",
            deliveryMode: "steer",
            forceSend: true,
            verboseOnly: true,
          }),
        },
        // Everything below must sit pending in ask mode.
        {
          label: "escalation/recovery interrupt",
          input: baseInput({ origin: "stall", deliveryMode: "interrupt" }),
        },
        {
          label: "Commander spawn (create_agent)",
          input: baseInput({
            origin: "commander",
            targetAgentId: "",
            kind: "spawn",
            spawnPlan: { provider: "omp", model: "m/model", summary: "Spawn a worker" },
          }),
        },
        {
          label: "Commander fleet spawn (fleet_create_agent)",
          input: baseInput({
            origin: "commander",
            targetAgentId: "",
            kind: "spawn",
            spawnPlan: {
              host: "peer-a",
              provider: "codex",
              summary: "Spawn a worker on peer-a",
            },
          }),
        },
        {
          label: "verifier spawn",
          input: baseInput({
            origin: "verifier",
            targetAgentId: "worker-1",
            kind: "spawn",
            spawnPlan: { provider: "omp", summary: "Spawn a verifier for worker-1" },
          }),
        },
        {
          label: "verifier -> worker contact (contact_worker)",
          input: baseInput({ origin: "verifier", deliveryMode: "interrupt" }),
        },
        {
          label: "worker -> verifier reply relay",
          input: baseInput({
            origin: "verifier",
            targetAgentId: "verifier-1",
            allowPairKey: "server-1:worker-1",
            message: "The worker replied with a status report.",
          }),
        },
        {
          label: "Commander -> worker send (fleet_send_prompt)",
          input: baseInput({ origin: "commander", targetAgentId: "worker-2" }),
        },
        {
          label: "Commander meta action (fleet_meta rename)",
          input: baseInput({
            origin: "commander",
            targetAgentId: "",
            kind: "meta",
            metaPlan: { action: "rename_project", targetId: "prj_x", newValue: "payments" },
          }),
        },
        {
          label: "Commander meta action (fleet_meta archive — destructive)",
          input: baseInput({
            origin: "commander",
            targetAgentId: "",
            classification: "destructive",
            kind: "meta",
            metaPlan: { action: "archive_workspace", targetId: "wks_x" },
          }),
        },
      ];

      const statuses = new Map<string, string>();
      for (const action of actionClasses) {
        const proposal = await harness.approvals.createProposal(action.input);
        statuses.set(action.label, proposal.status);
      }

      // Exemption path 1 (isForceSendNudge): the status-ask nudge auto-sends.
      expect(statuses.get("status-ask nudge")).toBe("sent");
      expect(harness.delivered).toHaveLength(1); // only the nudge delivered
      for (const [label, status] of statuses) {
        if (label !== "status-ask nudge") {
          expect(status, `${label} must wait for approval in ask mode`).toBe("pending");
        }
      }

      // Exemption path 2 (isAllowPairExempt), asserted separately: a
      // user-granted allow-pair auto-sends the rest of that exchange, even in
      // ask mode — a different pair still waits.
      const grant = await harness.approvals.createProposal(baseInput());
      expect(grant.status).toBe("pending");
      await harness.approvals.resolveProposal({
        proposalId: grant.id,
        action: "approve",
        allowPair: true,
      });
      const paired = await harness.approvals.createProposal(
        baseInput({ allowPairKey: "server-1:worker-1" }),
      );
      expect(paired.status).toBe("sent");
      const differentPair = await harness.approvals.createProposal(
        baseInput({ targetAgentId: "worker-3" }),
      );
      expect(differentPair.status).toBe("pending");
    } finally {
      await teardown(harness);
    }
  });

  test("a user-granted allow-pair remains the ONLY other ask-mode exemption", async () => {
    const harness = await build({ mode: "ask" });
    try {
      // First contact: pending → approve WITH allowPair.
      const first = await harness.approvals.createProposal(baseInput());
      expect(first.status).toBe("pending");
      await harness.approvals.resolveProposal({
        proposalId: first.id,
        action: "approve",
        allowPair: true,
      });
      // The rest of the pair auto-sends (even in ask mode) — worker pair key.
      const second = await harness.approvals.createProposal(
        baseInput({ allowPairKey: "server-1:worker-1" }),
      );
      expect(second.status).toBe("sent");
      // A DIFFERENT pair still waits — the exemption is pair-scoped.
      const other = await harness.approvals.createProposal(
        baseInput({ targetAgentId: "worker-3" }),
      );
      expect(other.status).toBe("pending");
    } finally {
      await teardown(harness);
    }
  });

  test("spawn-kind proposal approves via the spawn hook and records spawnedAgentId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-approvals-spawn-"));
    const store = new MissionControlStore({ paseoHome: dir, logger: createTestLogger() });
    await store.initialize();
    const delivered: Harness["delivered"] = [];
    const published: MissionControlProposal[] = [];
    let spawned: MissionControlProposal | null = null;
    const approvals = new MissionControlApprovals({
      store,
      presence: { isAgentFocused: () => false, getStoppedBy: () => null },
      logger: createTestLogger(),
      getMode: () => "ask",
      deliver: async (input) => {
        delivered.push(input);
      },
      publishProposalEvent: async (proposal) => {
        published.push(proposal);
        return { id: proposal.id };
      },
      spawn: async (proposal) => {
        spawned = proposal;
        return { ok: true, agentId: "spawned-42" };
      },
    });
    try {
      const proposal = await approvals.createProposal({
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "",
        message: "Spawn a worker",
        deliveryMode: "interrupt",
        reason: "Commander spawn",
        classification: "normal",
        kind: "spawn",
        spawnPlan: { provider: "omp", summary: "Spawn a worker" },
      });
      expect(proposal.status).toBe("pending");
      expect(delivered).toHaveLength(0); // spawns never "deliver" a message
      await approvals.resolveProposal({ proposalId: proposal.id, action: "approve" });
      expect(spawned?.id).toBe(proposal.id);
      expect(approvals.getProposal(proposal.id)?.status).toBe("sent");
      expect(approvals.getProposal(proposal.id)?.spawnedAgentId).toBe("spawned-42");
      expect(delivered).toHaveLength(0);
    } finally {
      await awaitStoreWrites(store);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed spawn surfaces its error and never writes a sent record", async () => {
    // Regression: the live "Approve does nothing" bug. The respond RPC
    // returned ok:true while the spawn executor failed, so the app showed
    // nothing. The approve must now return ok:false with the executor error so
    // the app can surface it (toast), and the store must never claim the
    // spawn applied ("sent") for a spawn that did not run.
    const spawn = vi.fn(async () => ({ ok: false as const, error: "fleet spawn failed: boom" }));
    const harness = await build({ mode: "ask", spawn });
    try {
      const proposal = await harness.approvals.createProposal({
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "",
        message: "Spawn learning-llm smoke test",
        deliveryMode: "interrupt",
        reason: "Commander spawn",
        classification: "normal",
        kind: "spawn",
        spawnPlan: { provider: "omp", summary: "Spawn a smoke test" },
      });
      expect(proposal.status).toBe("pending");

      const result = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(result).toEqual({ ok: false, error: "fleet spawn failed: boom" });
      expect(spawn).toHaveBeenCalledTimes(1);
      // No "sent" record: the pending record survives so the card keeps its
      // Approve affordance for a retry, but the failure is no longer silent.
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("pending");
      expect(harness.published.map((p) => p.status)).toEqual(["pending"]);
    } finally {
      await teardown(harness);
    }
  });

  test("a failed spawn stays pending and a retry re-attempts the spawn (visible errors, no lie)", async () => {
    // The click-loop half of the regression: the failure used to be silent
    // (ok:true, nothing visible). Now each attempt surfaces the error to the
    // caller while the card stays pending; once the executor succeeds the
    // proposal records sent + spawnedAgentId.
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "boom" })
      .mockResolvedValueOnce({ ok: true as const, agentId: "spawned-42" });
    const harness = await build({ mode: "ask", spawn });
    try {
      const proposal = await harness.approvals.createProposal({
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "",
        message: "Spawn a worker",
        deliveryMode: "interrupt",
        reason: "Commander spawn",
        classification: "normal",
        kind: "spawn",
        spawnPlan: { provider: "omp", summary: "Spawn a worker" },
      });

      const first = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(first).toEqual({ ok: false, error: "boom" });
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("pending");

      const second = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(second).toEqual({ ok: true });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("sent");
      expect(harness.approvals.getProposal(proposal.id)?.spawnedAgentId).toBe("spawned-42");
    } finally {
      await teardown(harness);
    }
  });

  test("an absent spawn executor surfaces the error without writing a sent record", async () => {
    const harness = await build({ mode: "ask" }); // no spawn hook
    try {
      const proposal = await harness.approvals.createProposal({
        origin: "commander",
        serverId: "server-1",
        targetAgentId: "",
        message: "Spawn a worker",
        deliveryMode: "interrupt",
        reason: "Commander spawn",
        classification: "normal",
        kind: "spawn",
        spawnPlan: { provider: "omp", summary: "Spawn a worker" },
      });
      const result = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(result).toEqual({ ok: false, error: "Spawn executor is not available" });
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("pending");
    } finally {
      await teardown(harness);
    }
  });

  test("auto mode sends every action class immediately (destructive still asks)", async () => {
    const harness = await build({ mode: "auto" });
    try {
      const spawn = await harness.approvals.createProposal(
        baseInput({
          origin: "commander",
          targetAgentId: "",
          kind: "spawn",
          spawnPlan: { provider: "omp", summary: "Spawn a worker" },
        }),
      );
      expect(spawn.status).toBe("sent");
      const send = await harness.approvals.createProposal(
        baseInput({ origin: "commander", targetAgentId: "worker-2" }),
      );
      expect(send.status).toBe("sent");
      expect(harness.delivered.map((d) => d.agentId)).toEqual(["worker-2"]);
      const destructive = await harness.approvals.createProposal(
        baseInput({ origin: "commander", classification: "destructive" }),
      );
      expect(destructive.status).toBe("pending");
    } finally {
      await teardown(harness);
    }
  });
});

// ============================================================================
// M4 meta-kind proposals: the Commander's fleet_meta actions (rename/archive
// project·workspace·agent, create project, move agent, promote workspace)
// ride the gate as kind "meta" proposals carrying a metaPlan. Same gate
// contract as spawn: ask mode holds the card, auto mode applies immediately,
// destructive (archive) always asks. Approve (or auto mode) executes through
// the applyMeta hook — never a message delivery.
// ============================================================================

describe("MissionControlApprovals meta kind", () => {
  const metaInput = (overrides: Partial<ProposalCreateInput> = {}): ProposalCreateInput =>
    baseInput({
      origin: "commander",
      targetAgentId: "",
      message: "Rename workspace wks_a to payments",
      kind: "meta",
      metaPlan: {
        action: "rename_workspace",
        targetId: "wks_a",
        newValue: "payments",
      },
      ...overrides,
    });

  test("ask mode holds the meta proposal pending; applyMeta never runs and nothing delivers", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const applied: MissionControlProposal[] = [];
      harness.approvals = new MissionControlApprovals({
        store: harness.store,
        presence: harness.presence,
        logger: createTestLogger(),
        getMode: () => harness.mode,
        deliver: async (input) => {
          harness.delivered.push(input);
        },
        publishProposalEvent: async (proposal) => {
          harness.published.push(proposal);
          return { id: `mce_${harness.published.length}` };
        },
        applyMeta: async (proposal) => {
          applied.push(proposal);
          return { ok: true };
        },
      });
      const proposal = await harness.approvals.createProposal(metaInput());
      expect(proposal.status).toBe("pending");
      expect(proposal.kind).toBe("meta");
      expect(proposal.metaPlan).toMatchObject({ action: "rename_workspace" });
      expect(harness.delivered).toHaveLength(0);
      expect(applied).toHaveLength(0);
      // The record survives the gate (store round-trip keeps the metaPlan).
      expect(harness.approvals.getProposal(proposal.id)?.metaPlan).toEqual(proposal.metaPlan);
    } finally {
      await teardown(harness);
    }
  });

  test("approve applies the meta action through applyMeta and records sent", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const applied: MissionControlProposal[] = [];
      harness.approvals = new MissionControlApprovals({
        store: harness.store,
        presence: harness.presence,
        logger: createTestLogger(),
        getMode: () => harness.mode,
        deliver: async (input) => {
          harness.delivered.push(input);
        },
        publishProposalEvent: async (proposal) => {
          harness.published.push(proposal);
          return { id: `mce_${harness.published.length}` };
        },
        applyMeta: async (proposal) => {
          applied.push(proposal);
          return { ok: true };
        },
      });
      const proposal = await harness.approvals.createProposal(metaInput());
      const result = await harness.approvals.resolveProposal({
        proposalId: proposal.id,
        action: "approve",
      });
      expect(result).toEqual({ ok: true });
      expect(applied).toHaveLength(1);
      expect(applied[0].metaPlan).toEqual(proposal.metaPlan);
      expect(harness.delivered).toHaveLength(0); // meta never "delivers" a message
      expect(harness.approvals.getProposal(proposal.id)?.status).toBe("sent");
      expect(harness.published.map((p) => p.status)).toEqual(["pending", "sent"]);
    } finally {
      await teardown(harness);
    }
  });

  test("auto mode applies the meta action immediately via applyMeta", async () => {
    const harness = await build({ mode: "auto" });
    try {
      const applied: MissionControlProposal[] = [];
      harness.approvals = new MissionControlApprovals({
        store: harness.store,
        presence: harness.presence,
        logger: createTestLogger(),
        getMode: () => harness.mode,
        deliver: async (input) => {
          harness.delivered.push(input);
        },
        publishProposalEvent: async (proposal) => {
          harness.published.push(proposal);
          return { id: `mce_${harness.published.length}` };
        },
        applyMeta: async (proposal) => {
          applied.push(proposal);
          return { ok: true };
        },
      });
      const proposal = await harness.approvals.createProposal(metaInput());
      expect(proposal.status).toBe("sent");
      expect(applied).toHaveLength(1);
      expect(applied[0].metaPlan?.action).toBe("rename_workspace");
      expect(harness.delivered).toHaveLength(0);
      expect(harness.published.map((p) => p.status)).toEqual(["sent"]);
    } finally {
      await teardown(harness);
    }
  });

  test("destructive meta classification (archive) always asks, even in auto mode", async () => {
    const harness = await build({ mode: "auto" });
    try {
      const applied: MissionControlProposal[] = [];
      harness.approvals = new MissionControlApprovals({
        store: harness.store,
        presence: harness.presence,
        logger: createTestLogger(),
        getMode: () => harness.mode,
        deliver: async (input) => {
          harness.delivered.push(input);
        },
        publishProposalEvent: async (proposal) => {
          harness.published.push(proposal);
          return { id: `mce_${harness.published.length}` };
        },
        applyMeta: async (proposal) => {
          applied.push(proposal);
          return { ok: true };
        },
      });
      const proposal = await harness.approvals.createProposal(
        metaInput({
          classification: "destructive",
          metaPlan: { action: "archive_agent", targetId: "agent-9" },
        }),
      );
      expect(proposal.status).toBe("pending");
      expect(applied).toHaveLength(0);
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("meta approval in ask mode also waits (gated per action class)", async () => {
    const harness = await build({ mode: "ask" });
    try {
      const proposal = await harness.approvals.createProposal(metaInput());
      expect(proposal.status).toBe("pending");
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });

  test("applyMeta failures never bounce a resolved proposal back to pending", async () => {
    const harness = await build({ mode: "auto" });
    try {
      harness.approvals = new MissionControlApprovals({
        store: harness.store,
        presence: harness.presence,
        logger: createTestLogger(),
        getMode: () => harness.mode,
        deliver: async (input) => {
          harness.delivered.push(input);
        },
        publishProposalEvent: async (proposal) => {
          harness.published.push(proposal);
          return { id: `mce_${harness.published.length}` };
        },
        applyMeta: async () => ({ ok: false as const, error: "workspace not found" }),
      });
      const proposal = await harness.approvals.createProposal(metaInput());
      // The caller sees "sent" (the auto-mode contract), but the proposal is
      // never recorded as applied: the store holds NO record (the action did
      // not run, so it must never read as applied/sent). Same contract as the
      // spawn hook.
      expect(proposal.status).toBe("sent");
      expect(harness.approvals.getProposal(proposal.id)).toBeNull();
      expect(harness.delivered).toHaveLength(0);
    } finally {
      await teardown(harness);
    }
  });
});
