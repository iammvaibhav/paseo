import { describe, expect, test } from "vitest";
import {
  createFleetHarness,
  fleetExec,
  resolveDeepseekModel,
  waitForAgentRow,
  waitForEvent,
} from "../test-utils/fleet-harness.js";

/**
 * Layer 2 real-model smoke (spec 08: deepseek v4 flash). One scenario: spawn
 * a REAL agent on B from A via fleet_create_agent, prompt it to write a file
 * and report_status completed, assert bucket ready + description present.
 *
 * The exact invocable provider/model string is resolved from the daemon's
 * provider snapshot (fleet_list_models) at test time; when the environment
 * has no deepseek v4 flash provider the test SKIPS loudly instead of failing.
 */
describe("real-model fleet spawn (deepseek v4 flash)", () => {
  test(
    "spawn real agent on B from A; write a file; report completed; bucket ready + description",
    { timeout: 300_000 },
    async () => {
      // No fake agent clients: the daemons probe REAL providers (omp etc.).
      // omp needs an explicit enable (the real-omp e2e pattern); without it
      // the spawn fails with "Provider 'omp' is disabled".
      const harness = await createFleetHarness({
        agentClients: {},
        providerOverrides: { omp: { enabled: true } },
      });
      try {
        const model = await resolveDeepseekModel(harness.clients.A, "local", 90_000);
        if (!model) {
          const roster = await fleetExec(harness.clients.A, "fleet_list_models", {
            host: "local",
          }).catch(() => ({ models: {} }));
          // Loud skip: the environment lacks the deepseek v4 flash provider.
          console.warn(
            `SKIP: no deepseek v4 flash provider in this environment. Available: ${JSON.stringify(roster.models ?? {})}`,
          );
          test.skip();
          return;
        }
        const targetCwd = `${harness.daemons.B.paseoHomeRoot}/real-worker`;
        const exec = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args: {
            host: "B",
            provider: model,
            initialPrompt:
              "Create a file named fleet-real-proof.txt containing the text PASS, then call report_status with status completed, headline 'real model proof', and description 'real-model fleet spawn proof'.",
            title: "Real model worker",
            cwd: targetCwd,
          },
        });
        expect(exec.ok).toBe(true);
        const proposalId = exec.structuredContent?.proposalId as string | undefined;
        let agentId = exec.structuredContent?.agentId as string | undefined;
        if (proposalId) {
          const approve = await harness.clients.A.missionControlProposalsRespond({
            proposalId,
            action: "approve",
          });
          expect(approve.ok).toBe(true);
          // The call-time payload is pending-approval (agentId null); the
          // spawned id arrives on the approved proposal event.
          const proposalEvent = await waitForEvent(
            harness.clients.A,
            (e) =>
              e.kind === "proposal" &&
              e.proposal?.id === proposalId &&
              Boolean(e.proposal?.spawnedAgentId),
            { label: "real spawn executed", timeoutMs: 120_000 },
          );
          agentId = proposalEvent.proposal?.spawnedAgentId as string | undefined;
        }
        if (!agentId) {
          throw new Error("real spawn produced no agentId and no proposalId");
        }
        const row = await waitForAgentRow(
          harness.clients.B,
          agentId,
          (r) => r.bucket === "ready" && Boolean(r.description),
          { timeoutMs: 240_000, label: "real agent ready with description" },
        );
        expect(row.bucket).toBe("ready");
        expect(row.description).toContain("real-model fleet spawn proof");
      } finally {
        await harness.close();
      }
    },
  );
});
