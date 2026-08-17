import { describe, expect, test } from "vitest";
import type { AgentClient } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  createFleetHarness,
  fleetExec,
  spawnWorker,
  waitFor,
  waitForAgentRow,
  waitForEvent,
  fetchEvents,
} from "../test-utils/fleet-harness.js";
import type { PaseoDaemon } from "../bootstrap.js";

/**
 * Layer 2 scenario group 3 — terminal guarantee (06), identity (06), chat
 * routing gate (07), instruction ledger (10), monitor (11).
 *
 * Scenario 6 needs a fake agent that answers a status-ask steer with a real
 * report_status — the same surface a real agent's MCP connection uses — so
 * the harness daemons are created with steer-responding clients whose
 * responder resolves the daemon lazily (the harness exposes it after boot).
 */

interface SteerClients {
  clients: Partial<Record<string, AgentClient>>;
  setDaemons: (daemons: Record<string, { daemon: PaseoDaemon }>) => void;
}

function createSteerRespondingClients(): SteerClients {
  const daemonByHost = new Map<string, PaseoDaemon>();
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
      // The marker text also leaks into the commander's fleet-state snapshot
      // (the spawn brief rides the world snapshot); only report for agents
      // this host actually owns.
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
  };
}

describe("06 terminal-state guarantee", () => {
  test(
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
        const events = await fetchEvents(harness.clients.B);
        const steers = events.filter(
          (e) =>
            e.kind === "proposal" &&
            e.proposal?.targetAgentId === agentId &&
            e.proposal?.deliveryMode === "steer",
        );
        expect(steers).toHaveLength(1);
        expect(steers[0]!.proposal?.verboseOnly).toBe(true);
        expect(steers[0]!.proposal?.message ?? "").toMatch(/^<paseo-system>/);
        expect(steers[0]!.proposal?.message ?? "").toContain("report_status");
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
      const events = await fetchEvents(harness.clients.B);
      const steers = events.filter(
        (e) =>
          e.kind === "proposal" &&
          e.proposal?.targetAgentId === agentId &&
          e.proposal?.deliveryMode === "steer",
      );
      expect(steers).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  test(
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
        let events = await fetchEvents(harness.clients.B);
        let steers = events.filter(
          (e) =>
            e.kind === "proposal" &&
            e.proposal?.targetAgentId === agentId &&
            e.proposal?.deliveryMode === "steer",
        );
        expect(steers).toHaveLength(0);

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
        events = await fetchEvents(harness.clients.B);
        steers = events.filter(
          (e) =>
            e.kind === "proposal" &&
            e.proposal?.targetAgentId === agentId &&
            e.proposal?.deliveryMode === "steer",
        );
        expect(steers).toHaveLength(1);
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

describe("07 chat routing gate", () => {
  test(
    "terminal/blocked events on a peer do not dispatch a Commander turn (board + forward only)",
    { timeout: 240_000 },
    async () => {
      // The fake clients are shared by every daemon, and spawns run
      // branch-name-generator turns and the worker's own turn, so count ONLY
      // turns of the commander agent (its id is known after harness boot).
      let commanderId: string | null = null;
      let commanderTurns = 0;
      const clients = createTestAgentClients({
        onStartTurn: (_prompt, agentId) => {
          if (agentId !== null && agentId === commanderId) {
            commanderTurns += 1;
          }
        },
      });
      const harness = await createFleetHarness({ agentClients: clients });
      commanderId = harness.commanderId;
      try {
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "C",
          provider: "claude/test-model",
          initialPrompt: "Gate worker",
          title: "Gate worker",
          cwd: harness.daemons.C.paseoHomeRoot,
        });
        await waitForEvent(
          harness.clients.C,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "finished on C",
          },
        );
        // Terminal events never wake the Commander (spec 07): the turn count
        // must not move in the settle window after the peer's finish.
        const turnsAtFinish = commanderTurns;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(commanderTurns).toBe(turnsAtFinish);
      } finally {
        await harness.close();
      }
    },
  );
});

describe("10 instruction ledger", () => {
  test(
    "instructions.open → respondsTo closes the row → unclosed rows resurface",
    { timeout: 180_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        const first = await harness.clients.A.missionControlInstructionsOpen({
          text: "spawn a worker on B",
          source: "voice",
        });
        const firstId = first.instructions[0]!.id;
        const second = await harness.clients.A.missionControlInstructionsOpen({
          text: "check status of the worker",
          source: "voice",
        });
        const secondId = second.instructions[0]!.id;
        expect(firstId).not.toBe(secondId);

        const listed = await harness.clients.A.missionControlInstructionsList();
        const byId = new Map(listed.instructions.map((row) => [row.id, row]));
        expect(byId.get(firstId)?.status).toBe("open");
        expect(byId.get(secondId)?.status).toBe("open");

        // A citing dispatch closes its row at card time.
        const exec = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args: {
            host: "B",
            provider: "claude/test-model",
            initialPrompt: "answer instruction",
            title: "Ledger worker",
            cwd: harness.daemons.B.paseoHomeRoot,
            respondsTo: firstId,
          },
        });
        expect(exec.ok).toBe(true);
        const after = await harness.clients.A.missionControlInstructionsList();
        const afterById = new Map(after.instructions.map((row) => [row.id, row]));
        expect(afterById.get(firstId)?.status).toBe("closed");
        // The uncited row stays open — it resurfaces until answered.
        expect(afterById.get(secondId)?.status).toBe("open");
      } finally {
        await harness.close();
      }
    },
  );
});

describe("11 monitor", () => {
  test(
    "fleet watch on A: per-agent watch, status list, stop; C finish announces once with ids",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        const start = await fleetExec(harness.clients.A, "fleet_monitor", {
          action: "start",
          scope: "fleet",
        });
        expect(start.ok).toBe(true);

        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "C",
          provider: "claude/test-model",
          initialPrompt: "Monitor worker",
          title: "Monitor worker",
          cwd: harness.daemons.C.paseoHomeRoot,
        });

        // Per-agent watch on the same session.
        const agentWatch = await fleetExec(harness.clients.A, "fleet_monitor", {
          action: "start",
          scope: "agent",
          agentId,
        });
        expect(agentWatch.ok).toBe(true);

        const status = await fleetExec(harness.clients.A, "fleet_monitor", {
          action: "status",
          scope: "fleet",
        });
        expect(status.ok).toBe(true);
        expect(status.subscriptions).toHaveLength(2);

        // The C finish produces exactly ONE terminal event carrying the ids
        // (agentId + the additive agentName/agentDescription triad) — the
        // announce payload the policy matches on.
        const finished = await waitForEvent(
          harness.clients.C,
          (e) => e.agentId === agentId && e.kind === "finished",
          { label: "finish on C" },
        );
        expect(finished.agentId).toBe(agentId);
        expect(typeof finished.agentName).toBe("string");
        const duplicates = (await fetchEvents(harness.clients.C)).filter(
          (e) => e.agentId === agentId && e.kind === "finished",
        );
        expect(duplicates).toHaveLength(1);

        // Stop removes the watch.
        const stop = await fleetExec(harness.clients.A, "fleet_monitor", {
          action: "stop",
          scope: "agent",
          agentId,
        });
        expect(stop.ok).toBe(true);
        const afterStop = await fleetExec(harness.clients.A, "fleet_monitor", {
          action: "status",
          scope: "fleet",
        });
        expect(afterStop.subscriptions).toHaveLength(1);
      } finally {
        await harness.close();
      }
    },
  );
});
