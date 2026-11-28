import { createDaemonClient } from "../lib/client.mjs";

export const meta = {
  name: "sanity",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Asserts daemon HTTP health, server_info status, WebSocket RPC roundtrip, web UI connection hint, password auth, and commander config.",
};

const ASSERT_BUDGET_MS = 1500;

function authHeaders(ctx) {
  return ctx.stack.password ? { Authorization: `Bearer ${ctx.stack.password}` } : {};
}

export const steps = [
  {
    id: "health",
    label: "Daemon answers health endpoint",
    narrate: "Daemon is healthy and answering loopback requests.",
    async run(ctx) {
      ctx.sanityT0 ??= Date.now();
      const host = ctx.host();
      const res = await fetch(`${host.httpUrl}/api/health`);
      ctx.expect(res.status === 200, `Health check returned ${res.status}`);
      const body = await res.json();
      ctx.expect(body.status === "ok", `Expected status ok, got ${body.status}`);
      return "health 200 ok";
    },
  },
  {
    id: "status",
    label: "Daemon reports server_info with serverId",
    narrate: "Status endpoint returns server identity.",
    async run(ctx) {
      const host = ctx.host();
      const res = await fetch(`${host.httpUrl}/api/status`, { headers: authHeaders(ctx) });
      ctx.expect(res.status === 200, `Status check returned ${res.status}`);
      const body = await res.json();
      ctx.expect(body.status === "server_info", `Expected server_info, got ${body.status}`);
      ctx.expect(
        typeof body.serverId === "string" && body.serverId.length > 0,
        "Status response carries a non-empty serverId",
      );
      return `server_info ${body.serverId}`;
    },
  },
  {
    id: "rpc-roundtrip",
    label: "WebSocket RPC roundtrip succeeds",
    narrate: "Authenticated WebSocket RPC answered.",
    async run(ctx) {
      const client = ctx.host().client;
      const snapshot = await client.getProvidersSnapshot({ cwd: ctx.host().home });
      ctx.expect(Array.isArray(snapshot.entries), "Providers snapshot has entries array");
      return `${snapshot.entries.length} provider entries resolved`;
    },
  },
  {
    id: "web-ui",
    label: "Web UI index carries a matching connection hint",
    narrate: "Web UI served with a connection hint for this host.",
    async run(ctx) {
      const host = ctx.host();
      const res = await fetch(`${host.httpUrl}/`, { headers: authHeaders(ctx) });
      ctx.expect(res.status === 200, `Web UI index returned ${res.status}`);
      const html = await res.text();
      const match = html.match(/window\.__PASEO_INITIAL_DAEMON_CONNECTION__=(\{.*?\})<\/script>/);
      ctx.expect(Boolean(match), "Index embeds __PASEO_INITIAL_DAEMON_CONNECTION__");
      const hint = JSON.parse(match[1]);
      const expectedListen = new URL(host.httpUrl).host;
      ctx.expect(
        hint.listen === expectedListen,
        `Connection hint listen ${hint.listen} matches host ${expectedListen}`,
      );
      return `hint listen ${hint.listen}`;
    },
  },
  {
    id: "code-server",
    label: "Shared code-server is reachable for this run's fixture folder",
    narrate: "Host code-server answers for the workspace folder the app would open.",
    async run(ctx) {
      if (!ctx.stack.codeServer) {
        return "SKIP: code-server not configured on this host (skipped)";
      }
      const { url } = ctx.stack.codeServer;
      const root = await fetch(`${url}/`, { redirect: "manual" });
      ctx.expect(
        root.status >= 200 && root.status < 400,
        `code-server root ${url}/ returned ${root.status}, want 2xx/3xx`,
      );
      const folderUrl = `${url}/?folder=${encodeURIComponent(ctx.fixtureRepo)}`;
      const folder = await fetch(folderUrl, { redirect: "manual" });
      ctx.expect(
        folder.status >= 200 && folder.status < 400,
        `code-server folder open ${folderUrl} returned ${folder.status}, want 2xx/3xx`,
      );
      return `${url} healthy, folder open ok`;
    },
  },
  {
    id: "auth",
    label: "Password gate rejects unauthenticated access",
    narrate: "Unauthenticated HTTP and WebSocket are rejected; authenticated RPC works.",
    async run(ctx) {
      if (!ctx.stack.password) {
        return "SKIP: stack has no password (--no-password)";
      }
      const host = ctx.host();
      const bare = await fetch(`${host.httpUrl}/api/status`);
      ctx.expect(bare.status === 401, `Unauthenticated status returned ${bare.status}, want 401`);

      const intruder = createDaemonClient(host.wsUrl, `verify-intruder-${Date.now()}`, null, {
        connectTimeoutMs: 3000,
        reconnect: { enabled: false },
      });
      let rejection = null;
      try {
        await intruder.connect();
      } catch (err) {
        rejection = err;
      } finally {
        await intruder.close().catch(() => {});
      }
      ctx.expect(Boolean(rejection), "Unauthenticated WebSocket connect was rejected");
      ctx.expect(
        /password|auth/i.test(rejection?.message || ""),
        `Rejection names auth, got: ${rejection?.message || rejection}`,
      );

      const cfg = await ctx.host().client.missionControlConfigGet();
      ctx.expect(Boolean(cfg.config), "Authenticated config get works");
      return "401 + WS rejected, authed RPC ok";
    },
  },
  {
    id: "commander-config",
    label: "Mission Control config names commander host and model",
    narrate: "Central config designates the commander and its model.",
    async run(ctx) {
      if (ctx.stack.commander?.enabled === false) {
        return "SKIP: commander disabled (--no-commander)";
      }
      const res = await ctx.host().client.missionControlConfigGet();
      ctx.expect(
        res.config?.commanderHost === "commander",
        `commanderHost is ${res.config?.commanderHost}, want commander`,
      );
      ctx.expect(
        res.config?.commanderModel === ctx.stack.commanderModel,
        `commanderModel is ${res.config?.commanderModel}, want ${ctx.stack.commanderModel}`,
      );
      return `commander@${res.config.commanderModel}`;
    },
  },
  {
    id: "budget",
    label: "Assertions complete within budget",
    narrate: "Sanity assertions stayed fast.",
    async run(ctx) {
      const elapsed = Date.now() - (ctx.sanityT0 ?? Date.now());
      ctx.expect(
        elapsed <= ASSERT_BUDGET_MS,
        `Sanity assertions took ${elapsed}ms, budget is ${ASSERT_BUDGET_MS}ms`,
      );
      return `${elapsed}ms of ${ASSERT_BUDGET_MS}ms`;
    },
  },
];
