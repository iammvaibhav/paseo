import net from "node:net";

export const meta = {
  name: "ui-connection-switch-reconnecting",
  tier: "ui",
  hosts: 1,
  video: true,
  description:
    "After the app swaps to a faster connection without dropping the old one first (make-before-break), " +
    "an open chat clears Reconnecting and still streams the agent's replies.",
};

const RECONNECTING_TOAST = '[data-testid="agent-reconnecting-toast"]';
const FORK_TRIGGER = '[data-testid="assistant-fork-menu-trigger"]';
const COMPOSER_INPUT = "textarea[data-composer-input]";

// A second endpoint for the same daemon: a TCP forwarder on its own port. The app keys
// connections by endpoint, so two names for one loopback port collapse into one connection.
async function startForwarder(targetPort) {
  const server = net.createServer((socket) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return server;
}

function connectionIds(ctx) {
  const port = new URL(ctx.host().httpUrl).port;
  return [`direct:127.0.0.1:${port}`, `direct:127.0.0.1:${ctx.forwarder.address().port}`];
}

async function finishedTurnCount(page) {
  return page.locator(`${FORK_TRIGGER}:visible`).count();
}

export const steps = [
  {
    id: "seed-agent",
    label: "Seed an agent with one finished turn",
    narrate: "Creating an agent and waiting for its first turn to finish.",
    async run(ctx) {
      const client = ctx.host().client;
      const workspace = await client.createWorkspace({
        source: { kind: "directory", path: ctx.fixtureRepo },
        title: `[${ctx.stack.runId}] connection switch`,
      });
      const workspaceId = workspace.workspace?.id;
      ctx.expect(Boolean(workspaceId), "workspace must have an id");
      const agent = await client.createAgent({
        provider: "mock",
        cwd: ctx.fixtureRepo,
        workspaceId,
        title: `[${ctx.stack.runId}] connection switch agent`,
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "say hello",
      });
      ctx.workspaceId = workspaceId;
      ctx.agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
      return `agent ${agent.id} idle in workspace ${workspaceId}`;
    },
  },
  {
    id: "open-chat-two-connections",
    label: "Open the chat on a host with two connections",
    narrate:
      "The host has two direct connections to the same daemon. The chat opens and is current.",
    async run(ctx) {
      const page = ctx.page;
      const host = ctx.host();
      ctx.expect(Boolean(page), "Playwright page must be available");
      ctx.forwarder = await startForwarder(Number(new URL(host.httpUrl).port));
      const [first, second] = connectionIds(ctx);
      const nowIso = new Date().toISOString();
      const hostProfile = {
        serverId: host.serverId,
        label: "commander",
        connections: [first, second].map((id) => ({
          id,
          type: "directTcp",
          endpoint: id.slice("direct:".length),
          password: ctx.password,
        })),
        preferredConnectionId: first,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      // Runs after the runner's seed script, so this registry wins.
      await page.addInitScript(
        (hosts) => {
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify(hosts));
        },
        [hostProfile],
      );

      const agentUrl = `${host.httpUrl}/h/${encodeURIComponent(host.serverId)}/workspace/${encodeURIComponent(ctx.workspaceId)}?open=agent:${encodeURIComponent(ctx.agentId)}`;
      await page.goto(agentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator(`${FORK_TRIGGER}:visible`).first().waitFor({ timeout: 20_000 });
      await page.locator(RECONNECTING_TOAST).waitFor({ state: "hidden", timeout: 15_000 });
      ctx.turnsBefore = await finishedTurnCount(page);
      await ctx.shot("before");
      return `chat open with ${ctx.turnsBefore} finished turn(s), no Reconnecting`;
    },
  },
  {
    id: "make-before-break-switch",
    label: "Swap to the other connection, make-before-break",
    narrate:
      "The app swaps to the other connection the way an adaptive switch does: the new socket connects before the old one closes.",
    async run(ctx) {
      const page = ctx.page;
      const serverId = ctx.host().serverId;
      // The adaptive probe needs three faster samples two minutes apart before it switches.
      // Call the same switch it makes, with keepActiveUntilConnected, instead of waiting.
      const result = await page.evaluate(async (hostServerId) => {
        const store = globalThis.__paseoHostRuntimeStore;
        const controller = store.controllers.get(hostServerId);
        const before = controller.getSnapshot();
        // The app normalizes endpoints, so take the ids from the host it loaded.
        const target = controller.host.connections
          .map((connection) => connection.id)
          .find((id) => id !== before.activeConnectionId);
        const clientBefore = before.client;
        await controller.switchToConnection({
          connectionId: target,
          keepActiveUntilConnected: true,
        });
        const after = controller.getSnapshot();
        return {
          from: before.activeConnectionId,
          to: after.activeConnectionId,
          target,
          status: after.connectionStatus,
          clientChanged: after.client !== clientBefore,
        };
      }, serverId);
      ctx.expect(
        result.to === result.target,
        `switch landed on ${result.to}, not ${result.target}: ${JSON.stringify(result)}`,
      );
      ctx.expect(result.status === "online", `host status after switch is ${result.status}`);
      ctx.expect(result.clientChanged, "the switch must hand the session a new client");
      return `switched ${result.from} -> ${result.to}; host stayed ${result.status}`;
    },
  },
  {
    id: "reconnecting-clears",
    label: "Reconnecting clears after the switch",
    narrate: "The chat does not stay on Reconnecting after the switch.",
    async run(ctx) {
      const page = ctx.page;
      // Give a stuck pill time to show, then require it gone.
      await page.waitForTimeout(3_000);
      try {
        await page.locator(RECONNECTING_TOAST).waitFor({ state: "hidden", timeout: 10_000 });
      } catch {
        await ctx.shot("stuck-reconnecting");
        throw new Error("Reconnecting is still shown 13s after a make-before-break switch");
      }
      return "no Reconnecting after the switch";
    },
  },
  {
    id: "agent-still-streams",
    label: "A new prompt streams its reply into the chat",
    narrate: "Sending another prompt from the composer streams the reply into the open chat.",
    async run(ctx) {
      const page = ctx.page;
      const composer = page.locator(`${COMPOSER_INPUT}:visible`).first();
      await composer.waitFor({ timeout: 10_000 });
      await composer.fill("say hello again");
      await composer.press("Enter");
      await ctx
        .host()
        .client.waitForAgentUpsert(ctx.agentId, (snapshot) => snapshot.status === "running", 15_000)
        .catch(() => undefined);
      await ctx
        .host()
        .client.waitForAgentUpsert(ctx.agentId, (snapshot) => snapshot.status === "idle", 20_000);
      const deadline = Date.now() + 15_000;
      let turns = await finishedTurnCount(page);
      while (turns <= ctx.turnsBefore && Date.now() < deadline) {
        await page.waitForTimeout(250);
        turns = await finishedTurnCount(page);
      }
      await ctx.shot("after");
      ctx.expect(
        turns > ctx.turnsBefore,
        `the second turn never reached the chat: ${turns} finished turn(s), expected more than ${ctx.turnsBefore}`,
      );
      return `chat shows ${turns} finished turns after the switch`;
    },
  },
];
