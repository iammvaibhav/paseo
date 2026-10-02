export const meta = {
  name: "daemon-agent-lifecycle",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Asserts daemon RPC health, workspace creation, and Mission Control lifecycle projection end to end.",
};

export const steps = [
  {
    id: "health",
    label: "Daemon answers health endpoint",
    narrate: "Daemon is healthy and answering loopback requests.",
    async run(ctx) {
      const host = ctx.host();
      const res = await fetch(`${host.httpUrl}/api/health`);
      ctx.expect(res.status === 200, `Health check returned ${res.status}`);
      const body = await res.json();
      ctx.expect(body.status === "ok", `Expected status ok, got ${body.status}`);
      return "health 200 ok";
    },
  },
  {
    id: "providers-snapshot",
    label: "Daemon returns providers snapshot over WebSocket",
    narrate: "WebSocket RPC handshake completed and providers queried.",
    async run(ctx) {
      const client = ctx.host().client;
      const snapshot = await client.getProvidersSnapshot({ cwd: ctx.host().home });
      ctx.expect(Array.isArray(snapshot.entries), "Providers snapshot has entries array");
      return `${snapshot.entries.length} provider entries resolved`;
    },
  },
  {
    id: "workspace-creation",
    label: "Create workspace and verify registry projection",
    narrate: "Workspace created and listed in workspace registry.",
    async run(ctx) {
      const client = ctx.host().client;
      const created = await client.createWorkspace({
        path: ctx.host().home,
        name: "verify-test-workspace",
      });
      const wsId = created.workspace?.id;
      ctx.expect(Boolean(wsId), "Workspace created with an id");

      const list = await client.listWorkspaces();
      const found = list.workspaces.find((w) => w.id === wsId);
      ctx.expect(Boolean(found), `Workspace ${wsId} found in listWorkspaces`);
      ctx.expect(found.name === "verify-test-workspace", "Workspace name matches");
      return `workspace ${wsId} registered`;
    },
  },
  {
    id: "mission-control-config",
    label: "Mission Control config get and patch",
    narrate: "Mission Control central config queried and patched.",
    async run(ctx) {
      const client = ctx.host().client;
      const configRes = await client.missionControlConfigGet();
      ctx.expect(Boolean(configRes.config), "Config response has config property");

      const patchRes = await client.missionControlConfigPatch({
        commanderHost: "commander",
      });
      ctx.expect(patchRes.ok === true, "Config patch succeeded");
      return "central config patched";
    },
  },
  {
    id: "mission-control-instructions",
    label: "Instruction lifecycle: open, list, close",
    narrate: "Instruction opened, verified on list, and closed.",
    async run(ctx) {
      const client = ctx.host().client;
      const openRes = await client.missionControlInstructionsOpen({
        text: "Verify fast parallel testing standard",
        source: "chat",
      });
      const instId = openRes.instruction?.id;
      ctx.expect(Boolean(instId), "Instruction opened with id");

      const listRes = await client.missionControlInstructionsList();
      const found = listRes.instructions?.find((item) => item.id === instId);
      ctx.expect(Boolean(found), `Instruction ${instId} present in list`);
      ctx.expect(
        found.text === "Verify fast parallel testing standard",
        "Instruction text matches",
      );

      const closeRes = await client.missionControlInstructionsClose({
        instructionId: instId,
      });
      ctx.expect(closeRes.ok === true, "Instruction close succeeded");
      return `instruction ${instId} opened and closed`;
    },
  },
  {
    id: "mission-control-tool-catalog",
    label: "Execute fleet tool via mission control catalog",
    narrate: "Fleet tool executed successfully via daemon tool catalog.",
    async run(ctx) {
      const client = ctx.host().client;
      const toolRes = await client.missionControlToolsExecute({
        name: "fleet_list_agents",
        args: {},
      });
      ctx.expect(toolRes.ok === true, `fleet_list_agents execution ok: ${toolRes.error}`);
      return "fleet_list_agents executed";
    },
  },
];
