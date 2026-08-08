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
  delivered: Array<{ agentId: string; message: string; deliveryMode: "steer" | "interrupt" }>;
  published: MissionControlProposal[];
}

async function build(overrides?: {
  mode?: "ask" | "auto";
  focused?: (agentId: string) => boolean;
  stoppedBy?: (agentId: string) => "user" | "machinery" | "system" | null;
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
  };
  harness.approvals = new MissionControlApprovals({
    store,
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
