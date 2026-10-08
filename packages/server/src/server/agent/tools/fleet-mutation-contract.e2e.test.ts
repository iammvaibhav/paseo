// In-process daemon acceptance for the spec 03 mutation contract: fleet
// mutations fail fast at call time with candidates, and identical mutations
// dedupe onto the existing pending proposal.
//
// Run:  npx vitest run packages/server/src/server/agent/tools/fleet-mutation-contract.e2e.test.ts --bail=1
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";

async function bootDaemonWithWorkspace(): Promise<{
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  workspaceId: string;
}> {
  const daemon: TestPaseoDaemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "fleet-mutation-contract" } });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-mc-contract-"));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Experiments",
  });
  const workspaceId = created.workspace.id;
  return { daemon, client, workspaceId };
}

describe("fleet mutation contract (spec 03) over the real daemon", () => {
  test("bad workspaceId is rejected at call time listing live candidates", async () => {
    const { daemon, client, workspaceId } = await bootDaemonWithWorkspace();
    try {
      const result = await client.missionControlToolsExecute({
        name: "fleet_create_agent",
        args: {
          host: "local",
          workspaceId: "wks_deadbeefdeadbeef",
          provider: "codex/gpt-5.4",
          initialPrompt: "run the backtest",
          title: "backtest",
        },
      });
      expect(result.ok).toBe(false);
      // The rejection names the field, the live wks_ candidates, and their titles.
      expect(result.error).toMatch(
        /workspace not found: wks_deadbeefdeadbeef is not a live workspace/,
      );
      expect(result.error).toMatch(
        new RegExp(`available workspaces: ${workspaceId.slice(0, 8)}… '[^']+'`),
      );
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  });

  test("duplicate spawn returns the existing proposalId with 'already pending'", async () => {
    const { daemon, client, workspaceId } = await bootDaemonWithWorkspace();
    try {
      const args = {
        host: "local",
        workspaceId,
        provider: "codex/gpt-5.4",
        initialPrompt: "run the backtest",
        title: "backtest",
      };
      const first = await client.missionControlToolsExecute({
        name: "fleet_create_agent",
        args,
      });
      expect(first.ok).toBe(true);
      const firstContent = first.structuredContent as { proposalId?: string; status?: string };
      expect(firstContent.status).toBe("pending-approval");
      expect(firstContent.proposalId).toMatch(/^mcp_/);

      const second = await client.missionControlToolsExecute({
        name: "fleet_create_agent",
        args,
      });
      expect(second.ok).toBe(true);
      const secondContent = second.structuredContent as {
        proposalId?: string;
        guidance?: string;
      };
      expect(secondContent.proposalId).toBe(firstContent.proposalId);
      expect(secondContent.guidance ?? "").toContain("already pending");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  });
});
