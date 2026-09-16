import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "fleet-agent-move",
  tier: "fleet",
  hosts: 2,
  video: true,
  description:
    "Verifies moving an agent across projects on the same host and moving an agent across hosts in the fleet over RPC and web UI.",
};

async function pollUntil(
  predicate,
  { timeoutMs = 15000, intervalMs = 100, description = "condition" } = {},
) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await predicate();
      if (result) {
        return result;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const elapsed = Date.now() - start;
  throw new Error(
    `Timed out after ${elapsed}ms waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

let commanderClient;
let peerBClient;
let commanderHome;
let peerBHome;

let projAlphaWsId;
let projAlphaDir;
let projBetaWsId;
let projBetaDir;
let peerBWsId;
let peerBWsDir;

let movingAgentId;
let uiAgentId;

export const steps = [
  {
    id: "peering-and-setup",
    label: "Verify peering and setup test projects and workspaces",
    narrate:
      "Commander and peer-b are mutually peered. Setting up workspaces for migration testing.",
    async run(ctx) {
      commanderClient = ctx.host("commander").client;
      peerBClient = ctx.host("peer-b").client;
      commanderHome = ctx.host("commander").home;
      peerBHome = ctx.host("peer-b").home;

      // Ensure peering link
      await pollUntil(
        async () => {
          const res = await commanderClient.missionControlPeersList();
          const peer = res.peers?.find((p) => p.name === "peer-b");
          return peer?.state === "online" ? res.peers : null;
        },
        { description: 'commander to report peer "peer-b" with state "online"' },
      );

      // Create two distinct project directories on commander
      projAlphaDir = path.join(commanderHome, "projects", "project-alpha");
      projBetaDir = path.join(commanderHome, "projects", "project-beta");
      peerBWsDir = path.join(peerBHome, "projects", "project-gamma");

      await fsp.mkdir(projAlphaDir, { recursive: true });
      await fsp.mkdir(projBetaDir, { recursive: true });
      await fsp.mkdir(peerBWsDir, { recursive: true });

      // Create Project Alpha workspace
      const alphaWs = await commanderClient.createWorkspace({
        source: { kind: "directory", path: projAlphaDir },
        title: "Alpha Workspace",
      });
      projAlphaWsId = alphaWs.workspace?.id;
      ctx.expect(Boolean(projAlphaWsId), "Project Alpha workspace created on commander");

      // Create Project Beta workspace (different project on same host)
      const betaWs = await commanderClient.createWorkspace({
        source: { kind: "directory", path: projBetaDir },
        title: "Beta Workspace",
      });
      projBetaWsId = betaWs.workspace?.id;
      ctx.expect(Boolean(projBetaWsId), "Project Beta workspace created on commander");

      // Create Workspace on peer-b (different host)
      const gammaWs = await peerBClient.createWorkspace({
        source: { kind: "directory", path: peerBWsDir },
        title: "Gamma Workspace",
      });
      peerBWsId = gammaWs.workspace?.id;
      ctx.expect(Boolean(peerBWsId), "Workspace created on peer-b");

      // Create test agent on commander in Project Alpha workspace
      const createdAgent = await commanderClient.createAgent({
        provider: "mock",
        cwd: projAlphaDir,
        workspaceId: projAlphaWsId,
        title: "Migrating Agent",
      });
      movingAgentId = createdAgent.id;
      ctx.expect(Boolean(movingAgentId), "Test agent created on commander");

      return `peered: commander <-> peer-b; created alpha ws (${projAlphaWsId}), beta ws (${projBetaWsId}), gamma ws (${peerBWsId})`;
    },
  },
  {
    id: "cross-project-move-rpc",
    label: "Move agent across projects on the same host via RPC",
    narrate: "Moving agent from Project Alpha workspace to Project Beta workspace.",
    async run(ctx) {
      // Call moveAgentToWorkspace to move movingAgentId to projBetaWsId on commander
      const moveRes = await commanderClient.moveAgentToWorkspace(movingAgentId, projBetaWsId);
      ctx.expect(
        moveRes.agentId === movingAgentId,
        "moveAgentToWorkspace returned matching agentId",
      );
      ctx.expect(
        moveRes.workspaceId === projBetaWsId,
        "moveAgentToWorkspace returned target workspaceId",
      );

      // Verify agent record on commander now has projBetaWsId and projBetaDir
      const agentRecord = await pollUntil(
        async () => {
          const fetched = await commanderClient.fetchAgent(movingAgentId);
          const agent = fetched?.agent;
          return agent?.workspaceId === projBetaWsId ? agent : null;
        },
        { description: `agent ${movingAgentId} to reflect workspaceId ${projBetaWsId}` },
      );

      ctx.expect(
        agentRecord.workspaceId === projBetaWsId,
        "Agent workspaceId updated to Project Beta",
      );
      ctx.expect(agentRecord.cwd === projBetaDir, "Agent cwd updated to Project Beta directory");

      return `agent ${movingAgentId} moved to project beta workspace ${projBetaWsId} at ${projBetaDir}`;
    },
  },
  {
    id: "cross-host-move-rpc",
    label: "Move agent across hosts in the fleet via RPC",
    narrate: "Moving agent from commander to peer-b in Gamma workspace.",
    async run(ctx) {
      // Move movingAgentId from commander to peer-b (peerBWsId).
      //
      // Send the shape the web UI sends: it knows the target host by serverId,
      // so it puts that serverId in BOTH fields. Addressing only the config
      // peer name ("peer-b") used to pass here while the app failed with
      // "Workspace <id> not found on this host" for a reachable peer.
      const peerBServerId = ctx.stack.hosts.find((host) => host.name === "peer-b")?.serverId;
      ctx.expect(
        typeof peerBServerId === "string" && peerBServerId.length > 0,
        "peer-b reports a serverId to address it by",
      );
      const moveRes = await commanderClient.moveAgentToWorkspace(movingAgentId, peerBWsId, {
        targetServerId: peerBServerId,
        targetHost: peerBServerId,
      });
      ctx.expect(moveRes.agentId === movingAgentId, "Cross-host move returned matching agentId");
      ctx.expect(moveRes.workspaceId === peerBWsId, "Cross-host move returned target workspaceId");

      // Verify agent is removed from commander
      await pollUntil(
        async () => {
          const agents = await commanderClient.fetchAgents();
          const found = agents.entries.some((e) => e.agent.id === movingAgentId);
          return !found;
        },
        { description: `agent ${movingAgentId} to be removed from commander` },
      );

      // Verify agent is now present on peer-b
      const peerBAgent = await pollUntil(
        async () => {
          const fetched = await peerBClient.fetchAgent(movingAgentId).catch(() => null);
          const agent = fetched?.agent;
          return agent?.workspaceId === peerBWsId ? agent : null;
        },
        { description: `agent ${movingAgentId} to appear on peer-b in workspace ${peerBWsId}` },
      );

      ctx.expect(peerBAgent.id === movingAgentId, "Agent ID preserved on peer-b");
      ctx.expect(peerBAgent.title === "Migrating Agent", "Agent title preserved on peer-b");
      ctx.expect(
        peerBAgent.workspaceId === peerBWsId,
        "Agent workspaceId updated to peer-b workspace",
      );
      ctx.expect(peerBAgent.cwd === peerBWsDir, "Agent cwd updated to peer-b workspace directory");

      return `agent ${movingAgentId} moved across hosts to peer-b workspace ${peerBWsId}`;
    },
  },
  {
    id: "ui-agent-move",
    label: "Drive Web UI to move an agent via Move Dialog",
    narrate: "Using Web UI Move Dialog to relocate an agent to another project and host.",
    async run(ctx) {
      const page = ctx.page;
      ctx.expect(Boolean(page), "Playwright page must be available for UI tier");

      // Create a second agent on commander for the UI test
      const uiAgent = await commanderClient.createAgent({
        provider: "mock",
        cwd: projAlphaDir,
        workspaceId: projAlphaWsId,
        title: "UI Move Agent",
      });
      uiAgentId = uiAgent.id;

      const host = ctx.host("commander");
      const serverId = ctx.stack.hosts[0].serverId;
      await page.goto(
        `${host.httpUrl}/h/${serverId}/workspace/${projAlphaWsId}?open=${encodeURIComponent(`agent:${uiAgentId}`)}`,
        { waitUntil: "domcontentloaded", timeout: 15_000 },
      );

      const tabLocator = page.locator(`[data-testid="workspace-tab-agent_${uiAgentId}"]`).first();
      await tabLocator.waitFor({ state: "visible", timeout: 30_000 });
      const beforeShot = await ctx.shot("before");
      ctx.expect(Boolean(beforeShot), "Captured before screenshot");

      // Right-click agent tab to open tab context menu
      await tabLocator.click({ button: "right" });

      const contextMenu = page.locator(`[data-testid="workspace-tab-context-agent_${uiAgentId}"]`);
      await contextMenu.waitFor({ state: "visible", timeout: 10_000 });

      const moveMenuItem = page.locator(
        `[data-testid="workspace-tab-context-agent_${uiAgentId}-move-agent"]`,
      );
      await moveMenuItem.waitFor({ state: "visible", timeout: 10_000 });
      await moveMenuItem.click({ force: true });

      const moveModal = page.locator('[data-testid="move-agent-modal"]');
      await moveModal.waitFor({ state: "visible", timeout: 10_000 });

      const projectBetaChip = page.locator('[data-testid^="move-target-project-"]').filter({
        hasText: "project-beta",
      });
      await projectBetaChip.click({ force: true });

      const targetOption = page.locator(`[data-testid="move-target-workspace-${projBetaWsId}"]`);
      try {
        await targetOption.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
        await targetOption.click({ timeout: 30_000, force: true });
      } catch (err) {
        await ctx.shot("modal-open");
        const modalHtml = await page
          .locator('[data-testid="move-agent-modal"]')
          .evaluate((el) => el.outerHTML.slice(0, 4000))
          .catch(() => "<modal not queryable>");
        const optionCount = await page
          .locator('[data-testid^="move-target-workspace-"]')
          .count()
          .catch(() => -1);
        throw new Error(
          `Beta workspace option missing (found ${optionCount} workspace options). Modal HTML: ${modalHtml}`,
          { cause: err },
        );
      }

      const submitButton = page.locator('[data-testid="move-agent-submit"]');
      await submitButton.click();

      await moveModal.waitFor({ state: "hidden", timeout: 10_000 });

      // Verify agent now belongs to projBetaWsId on commander
      await pollUntil(
        async () => {
          const fetched = await commanderClient.fetchAgent(uiAgentId);
          return fetched?.agent?.workspaceId === projBetaWsId ? fetched.agent : null;
        },
        { description: `UI agent ${uiAgentId} moved to ${projBetaWsId}` },
      );

      const afterShot = await ctx.shot("after");
      ctx.expect(Boolean(afterShot), "Captured after screenshot");

      return `UI move succeeded: agent ${uiAgentId} relocated via Move Dialog to ${projBetaWsId}`;
    },
  },
];
