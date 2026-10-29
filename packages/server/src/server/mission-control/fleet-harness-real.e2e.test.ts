import { describe, expect, test } from "vitest";
import {
  createFleetHarness,
  fleetExec,
  resolveDeepseekModel,
  waitForAgentRow,
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
        const exec = await fleetExec(harness.clients.A, "fleet_create_agent", {
          host: "B",
          provider: model,
          initialPrompt:
            "Create a file named fleet-real-proof.txt containing the text PASS, then call report_status with status completed, headline 'real model proof', and description 'real-model fleet spawn proof'.",
          title: "Real model worker",
          cwd: targetCwd,
        });
        const agentId = exec.agentId;
        if (typeof agentId !== "string") {
          throw new Error(`real spawn produced no agentId: ${JSON.stringify(exec)}`);
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
