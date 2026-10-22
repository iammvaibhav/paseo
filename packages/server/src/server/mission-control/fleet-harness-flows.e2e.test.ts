import { describe, expect, test } from "vitest";
import type { AgentClient } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  createFleetHarness,
  spawnWorker,
  waitFor,
  waitForAgentRow,
  waitForEvent,
} from "../test-utils/fleet-harness.js";
import type { PaseoDaemon } from "../bootstrap.js";

/**
 * Layer 2 scenario group 3 — terminal guarantee (06) and identity (06).
 *
 * Scenario 6 needs a fake agent that answers a status-ask steer with a real
 * report_status — the same surface a real agent's MCP connection uses — so
 * the harness daemons are created with steer-responding clients whose
 * responder resolves the daemon lazily (the harness exposes it after boot).
 */

interface SteerClients {
  clients: Partial<Record<string, AgentClient>>;
  setDaemons: (daemons: Record<string, { daemon: PaseoDaemon }>) => void;
  /** Status-ask steers the agent has received so far. */
  statusAsks: (agentId: string) => number;
}

function createSteerRespondingClients(): SteerClients {
  const daemonByHost = new Map<string, PaseoDaemon>();
  const statusAskCount = new Map<string, number>();
  const clients = createTestAgentClients({
    // A self-reporting agent: the launch brief carries the marker, so the
    // FIRST run lands a report (under the real daemon-side agent id, passed
    // by the seam) before finishing — tier 1, zero steers.
    onStartTurn: async (prompt, agentId) => {
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      if (!text.includes("SELF_REPORT_MARKER")) {
        return;
      }
      const daemon = daemonByHost.get("B");
      if (!daemon || !agentId) {
        return;
      }
      // Only report for agents this host owns.
      if (!daemon.agentManager.getAgent(agentId)) {
        return;
      }
      const catalog = await daemon.agentManager.createPaseoToolCatalog({
        callerAgentId: agentId,
      });
      if (!catalog) {
        return;
      }
      await catalog.executeTool("report_status", {
        status: "completed",
        headline: "Self-reported completion",
        description: "self-reporting worker finished",
      });
    },
    // The status-ask steer (a <paseo-system> envelope asking for
    // report_status): answer with a real report through the daemon catalog.
    onStatusAskSteer: async ({ agentId }) => {
      statusAskCount.set(agentId, (statusAskCount.get(agentId) ?? 0) + 1);
      const daemon = daemonByHost.get("B");
      if (!daemon) {
        return;
      }
      const catalog = await daemon.agentManager.createPaseoToolCatalog({ callerAgentId: agentId });
      if (!catalog) {
        return;
      }
      await catalog.executeTool("report_status", {
        status: "working",
        kind: "milestone",
        headline: "Steer answered",
        description: "answered the status ask with a fresh report",
      });
    },
  });
  return {
    clients,
    setDaemons: (daemons) => {
      for (const [name, entry] of Object.entries(daemons)) {
        daemonByHost.set(name, entry.daemon);
      }
    },
    statusAsks: (agentId) => statusAskCount.get(agentId) ?? 0,
  };
}

// DISABLED(temp): the end-of-run status ask is switched off in
// mission-control/service.ts, so the steer-firing scenarios below are
// skipped. Unskip together with the tier-2 block there.
describe("06 terminal-state guarantee", () => {
  test.skip(
    "silent finish → exactly one machinery-envelope steer → report lands → description on record",
    { timeout: 240_000 },
    async () => {
      const steer = createSteerRespondingClients();
      const harness = await createFleetHarness({ agentClients: steer.clients });
      steer.setDaemons(harness.daemons);
      try {
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "Fix the auth bug",
          title: "Silent worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "finished",
          },
        );
        // The steer's own run answers with report_status; wait for the report.
        await waitForEvent(harness.clients.B, (e) => e.agentId === agentId && e.source === "self", {
          label: "steer-answer report landed",
        });
        // Exactly ONE status-ask steer for the whole chain.
        expect(steer.statusAsks(agentId)).toBe(1);
        // Description from the steer-answer report is on the record.
        const row = await waitForAgentRow(
          harness.clients.B,
          agentId,
          (r) => Boolean(r.description),
          {
            label: "description on record",
          },
        );
        expect(row.description).toContain("answered the status ask");
      } finally {
        await harness.close();
      }
    },
  );

  test("self-reporting agent → zero steers", { timeout: 240_000 }, async () => {
    const steer = createSteerRespondingClients();
    const harness = await createFleetHarness({ agentClients: steer.clients });
    steer.setDaemons(harness.daemons);
    try {
      const { agentId } = await spawnWorker({
        from: harness.clients.A,
        host: "B",
        provider: "claude/test-model",
        initialPrompt: "SELF_REPORT_MARKER finish the task",
        title: "Self reporter",
        cwd: harness.daemons.B.paseoHomeRoot,
      });
      // The report lands during the run; its "finished"-kind self card is
      // superseded by the run-end system finish card (feed coalescing), so
      // sync on the report's durable side effect instead: the record's
      // shortDescription is written by the same reportSelfStatus flow.
      const readStoredDescription = async (): Promise<string | null> => {
        const record = await harness.daemons.B.daemon.agentStorage.get(agentId).catch(() => null);
        return record?.shortDescription ?? null;
      };
      await waitFor(
        readStoredDescription,
        (description) => (description ?? "").includes("self-reporting worker finished"),
        { label: "self report landed (description on record)" },
      );
      await waitForEvent(harness.clients.B, (e) => e.agentId === agentId && e.kind === "finished", {
        label: "finished",
      });
      expect(steer.statusAsks(agentId)).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test.skip(
    "mid-run silence produces zero steers; the run-end finish still steers exactly once",
    { timeout: 240_000 },
    async () => {
      const steer = createSteerRespondingClients();
      const harness = await createFleetHarness({ agentClients: steer.clients });
      steer.setDaemons(harness.daemons);
      try {
        // The permission gate holds the run open (a Bash write in ask mode)
        // — a silent mid-run state. No steer may exist while it is held.
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: 'create a file named "hold.txt" with the content "x"',
          title: "Held worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === agentId && e.kind === "blocked",
          {
            label: "blocked on permission",
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(steer.statusAsks(agentId)).toBe(0);

        // Release the hold (approve the permission): the run finishes
        // silently and the terminal guarantee fires its single steer.
        const snapshot = await harness.clients.B.fetchAgent({ agentId, timeout: 10_000 });
        const permission = snapshot.agent.pendingPermissions[0];
        expect(permission).toBeTruthy();
        await harness.clients.B.respondToPermission(agentId, permission!.id, {
          behavior: "allow",
          message: "ok",
        });
        await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "finished after release",
          },
        );
        await waitForEvent(harness.clients.B, (e) => e.agentId === agentId && e.source === "self", {
          label: "steer-answer report",
        });
        expect(steer.statusAsks(agentId)).toBe(1);
      } finally {
        await harness.close();
      }
    },
  );
});

describe("06/07 identity", () => {
  test(
    "title written at registration; title freeze; description nag; event identity triad",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "Identity worker",
          title: "Identity title",
          cwd: harness.daemons.B.paseoHomeRoot,
        });
        // Title at registration (explicit title passed through the spawn).
        const row = await waitForAgentRow(
          harness.clients.B,
          agentId,
          (r) => r.title === "Identity title",
          {
            label: "title at registration",
          },
        );
        expect(row.title).toBe("Identity title");

        // A report_status that also sends a title must NOT retitle (freeze);
        // a missing description triggers the nag notice.
        const record = await harness.daemons.B.daemon.agentStorage.get(agentId);
        const catalog = await harness.daemons.B.daemon.agentManager.createPaseoToolCatalog({
          callerAgentId: agentId,
        });
        const result = await catalog!.executeTool("report_status", {
          status: "working",
          headline: "Freeze check",
          title: "Trying to retitle",
          description: "living description here",
        });
        const content = result.structuredContent as Record<string, unknown>;
        // The freeze tells the agent its title write was ignored.
        expect(content.notice ?? "").toMatch(/title is fixed/);
        const after = await harness.daemons.B.daemon.agentStorage.get(agentId);
        expect(after?.title).toBe("Identity title");

        // Event identity triad: the report event carries agentName + agentDescription.
        const reportEvent = await waitForEvent(
          harness.clients.B,
          (e) => e.agentId === agentId && e.source === "self" && e.headline === "Freeze check",
          { label: "report event" },
        );
        expect(typeof reportEvent.agentName).toBe("string");
        expect(reportEvent.agentDescription).toContain("living description");
        void record;
      } finally {
        await harness.close();
      }
    },
  );
});
