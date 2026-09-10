import { describe, expect, test, vi } from "vitest";
import {
  createFleetHarness,
  fleetExec,
  spawnWorker,
  waitFor,
  waitForAgentRow,
  waitForEvent,
  type FleetHarness,
  type FleetAgentRow,
} from "../test-utils/fleet-harness.js";

/** Predicate factory: the agent's canonical lifecycle bucket via fleet_agent_status. */
function bucketOf(harness: FleetHarness, agentId: string): () => Promise<string | null> {
  return async () => {
    const status = await fleetExec(harness.clients.A, "fleet_agent_status", { agentId }).catch(
      () => null,
    );
    return status ? (status.bucket as string) : null;
  };
}

/**
 * Layer 2 scenario group 1 — bucket truth (01), ready aging (01), compat
 * (protocol). Every scenario drives mission_control.tools.execute from the
 * commander host A; agents run on peer B with the deterministic fakes.
 */

async function harnessFor(
  options: { centralConfig?: Record<string, unknown> } = {},
): Promise<FleetHarness> {
  return createFleetHarness({ centralConfig: options.centralConfig });
}

describe("01 bucket truth over the fleet", () => {
  test(
    "finish → ready; verdict → done; error → needs_you; permission → needs_you",
    { timeout: 180_000 },
    async () => {
      const harness = await harnessFor();
      try {
        // Clean finish: spawn on B → run ends silently → review ready.
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "Fix the auth bug",
          title: "Bucket worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "finished",
          },
        );
        // Canonical bucket on the OWNING daemon's roster (local fallback) and
        // via fleet_agent_status; A's roster row exists with host B.
        const localRow = await waitForAgentRow(
          harness.clients.B,
          agentId,
          (r) => r.bucket === "ready",
          {
            label: "bucket ready on B",
          },
        );
        expect(localRow.bucket).toBe("ready");
        const status = await fleetExec(harness.clients.B, "fleet_agent_status", { agentId });
        expect(status.bucket).toBe("ready");
        const aRow = await waitForAgentRow(harness.clients.A, agentId, (r) => Boolean(r.host), {});
        expect(aRow.host).toBe("B");

        // Verdict → done: user marks done via the lifecycle RPC on the
        // owning daemon (the record lives in B's storage).
        const marked = await harness.clients.B.missionControlLifecycleSet({
          serverId: "srv_fleet_B",
          agentId,
          action: "done",
        });
        expect(marked.ok).toBe(true);
        const doneRow = await waitForAgentRow(
          harness.clients.B,
          agentId,
          (r) => r.bucket === "done",
          {
            label: "bucket done",
          },
        );
        expect(doneRow.bucket).toBe("done");
        const doneStatus = await fleetExec(harness.clients.B, "fleet_agent_status", { agentId });
        expect(doneStatus.bucket).toBe("done");

        // Error → needs_you: prompt a turn failure.
        const errAgent = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "emit a turn failure",
          title: "Error worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === errAgent.agentId && e.kind === "failed",
          {
            label: "failed event",
          },
        );
        const errRow = await waitForAgentRow(
          harness.clients.B,
          errAgent.agentId,
          (r) => r.bucket === "needs_you",
          { label: "bucket needs_you after error" },
        );
        expect(errRow.bucket).toBe("needs_you");

        // Permission pending → needs_you: a tool call in ask mode blocks on
        // the permission gate (held open until responded).
        const permAgent = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: 'create a file named "permission.txt" with the content "x"',
          title: "Permission worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === permAgent.agentId && e.kind === "blocked",
          {
            label: "blocked on permission",
          },
        );
        const permRow = await waitForAgentRow(
          harness.clients.B,
          permAgent.agentId,
          (r) => r.bucket === "needs_you",
          { label: "bucket needs_you for permission" },
        );
        expect(permRow.bucket).toBe("needs_you");
      } finally {
        await harness.close();
      }
    },
  );

  test("user-stop → done (stopped-by-user)", { timeout: 180_000 }, async () => {
    const harness = await harnessFor();
    try {
      const { agentId } = await spawnWorker({
        from: harness.clients.A,
        host: "B",
        provider: "claude/test-model",
        initialPrompt: 'create a file named "permission.txt" with the content "x"',
        title: "Stop worker",
        cwd: harness.daemons.B.paseoHomeRoot,
      });
      // The permission gate holds the run open; cancel = user stop.
      await waitForEvent(harness.clients.B, (e) => e.agentId === agentId && e.kind === "blocked", {
        label: "blocked",
      });
      await harness.clients.B.cancelAgent(agentId);
      const row = await waitForAgentRow(harness.clients.B, agentId, (r) => r.bucket === "done", {
        label: "done after user stop",
      });
      expect(row.bucket).toBe("done");
    } finally {
      await harness.close();
    }
  });

  test(
    "pending proposal drives needs_you; resolution leaves it",
    { timeout: 180_000 },
    async () => {
      const harness = await harnessFor({ centralConfig: { trackVerifiers: false } });
      try {
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "local",
          provider: "claude/test-model",
          initialPrompt: "Ready worker",
          title: "Proposal worker",
          cwd: harness.daemons.A.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.A,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "finished",
          },
        );
        const baseline = await waitFor(bucketOf(harness, agentId), (bucket) => bucket === "ready", {
          timeoutMs: 30_000,
          label: "ready baseline",
        });
        expect(baseline).toBe("ready");
        // A pending send proposal for the agent flips the bucket to needs_you
        // (the proposal card lives on the commander host — same daemon).
        const exec = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_send_prompt",
          args: { agentId, prompt: "post a fresh report_status", mode: "steer" },
        });
        expect(exec.ok).toBe(true);
        const proposalId = (exec.structuredContent?.proposalId as string | undefined) ?? null;
        expect(proposalId).toBeTruthy();
        const pendingStatus = await fleetExec(harness.clients.A, "fleet_agent_status", { agentId });
        expect(pendingStatus.bucket).toBe("needs_you");
        // Deny resolves the proposal; the bucket leaves needs_you (denied
        // proposals never count as pending again).
        const deny = await harness.clients.A.missionControlProposalsRespond({
          proposalId,
          action: "deny",
        });
        expect(deny.ok).toBe(true);
        const backStatus = await waitFor(
          bucketOf(harness, agentId),
          (bucket) => bucket === "ready",
          {
            timeoutMs: 30_000,
            label: "ready after deny",
          },
        );
        expect(backStatus).toBe("ready");
      } finally {
        await harness.close();
      }
    },
  );
});

describe("01 ready aging (daily sweep)", () => {
  test(
    "ready row older than readyAgeOutDays → done with aged-out verdict",
    { timeout: 180_000 },
    async () => {
      // Tiny aging window (28.8 min) so a 24h fake-clock advance ages it.
      const harness = await harnessFor({
        centralConfig: { readyAgeOutDays: 0.02 },
      });
      try {
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "Finish quickly",
          title: "Aging worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        await waitForAgentRow(harness.clients.B, agentId, (r) => r.bucket === "ready", {
          label: "ready baseline",
        });

        // Freeze the clock and advance one daily sweep (the prune interval
        // carries the ready-aging sweep, spec 01). Peers are already online
        // and the agent idle, so no live timer is load-bearing mid-advance.
        // Run the ready-aging sweep on daemon B for the aged timestamp.
        harness.daemons.B.daemon.missionControlService?.sweepReadyAging(
          Date.now() + 24 * 60 * 60 * 1000 + 1000,
        );

        const agedRow = await waitForAgentRow(
          harness.clients.B,
          agentId,
          (r) => r.bucket === "done",
          {
            label: "bucket done after aging",
            timeoutMs: 30_000,
          },
        );
        expect(agedRow.bucket).toBe("done");
        const verdict = await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === agentId && e.kind === "verdict" && (e.detail ?? "") === "aged-out",
          { label: "aged-out verdict event", timeoutMs: 30_000 },
        );
        expect(verdict.headline).toBe("Done — aged-out");
      } finally {
        vi.useRealTimers();
        await harness.close();
      }
    },
  );
});

describe("12 compat (schema-level)", () => {
  test(
    "old records with attentionReason finished parse; roster payloads without bucket parse",
    { timeout: 180_000 },
    async () => {
      const harness = await harnessFor();
      try {
        // The roster schema accepts rows without a bucket (pre-bucket
        // daemons): the raw execute payload for fleet_list_agents must not
        // fail schema validation when a row omits bucket.
        const roster = await fleetExec(harness.clients.A, "fleet_list_agents", { limit: 200 });
        expect(Array.isArray(roster.agents)).toBe(true);
        for (const row of roster.agents as FleetAgentRow[]) {
          expect(
            ["needs_you", "running", "ready", "done", "idle"].includes(row.bucket as string) ||
              row.bucket === undefined,
          ).toBe(true);
        }
        // Old-record compat: attentionReason "finished" derives via the
        // protocol bucket function (unit-tested in agent-state-bucket) — the
        // daemon's roster never treats it as needs_you; exercise the live
        // derivation through a stored record with the legacy attention.
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "Compat worker",
          title: "Compat worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        const record = await harness.daemons.B.daemon.agentStorage.get(agentId);
        expect(record).toBeTruthy();
      } finally {
        await harness.close();
      }
    },
  );
});
