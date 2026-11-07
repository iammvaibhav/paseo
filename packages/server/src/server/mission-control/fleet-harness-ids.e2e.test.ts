import { mkdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createFleetHarness,
  fleetExec,
  fleetTry,
  spawnWorker,
  waitFor,
  waitForAgentRow,
  waitForEvent,
  type FleetAgentRow,
  type FleetHarness,
} from "../test-utils/fleet-harness.js";

/** Predicate factory: whether the named peer is offline on the commander host. */
function peerOffline(harness: FleetHarness, peerName: string): () => Promise<boolean | null> {
  return async () => {
    const peers = await harness.clients.A.missionControlPeersList().catch(() => ({ peers: [] }));
    const peer = peers.peers.find((entry) => entry.name === peerName);
    return peer === undefined ? true : peer.state !== "online";
  };
}

/**
 * Layer 2 scenario group 2 — fleet ids (02), fail-fast spawn (03), meta split
 * (04), driven over /mcp/fleet from host A.
 */

describe("02 fleet ids — bare-id routing", () => {
  test(
    "bare-id activity/send/meta-rename resolve without host; host-hint mismatch errors; C stopped names C",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        // Seed a workspace + agent on C (the agent the Commander can only
        // address by bare id).
        const cWs = await harness.clients.C.createWorkspace({
          source: { kind: "directory", path: harness.daemons.C.paseoHomeRoot },
          title: "C workspace",
        });
        const cWsId = cWs.workspace?.id;
        expect(cWsId).toBeTruthy();
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "C",
          provider: "claude/test-model",
          initialPrompt: "C worker",
          title: "C worker",
          workspaceId: cWsId as string,
        });
        await waitForAgentRow(harness.clients.C, agentId, (r) => Boolean(r.id), {});

        // Bare-id activity read from A (no host hint; freshly-finished worker resolves without kick).
        const activity = await fleetExec(harness.clients.A, "fleet_get_agent_activity", {
          agentId,
        });
        expect(activity.agentId).toBe(agentId);

        // Bare-id send resolves WITHOUT a host hint and routes over peering to C.
        const send = await fleetTry(harness.clients.A, "fleet_send_prompt", {
          agentId,
          prompt: "continue",
          mode: "steer",
        });
        expect(send.ok).toBe(true);
        // Verify prompt landed on C (turn ran and finished).
        await waitForEvent(
          harness.clients.C,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "peer send delivered and finished on C",
          },
        );
        // Bare-id meta rename → title changes on C.
        const rename = await fleetTry(harness.clients.A, "fleet_rename_agent_title", {
          agentId,
          title: "Renamed from A",
        });
        expect(rename.ok).toBe(true);
        const renamed = await waitForAgentRow(
          harness.clients.C,
          agentId,
          (r) => r.title === "Renamed from A",
          {
            label: "title renamed on C",
          },
        );
        expect(renamed.title).toBe("Renamed from A");

        // Host-hint mismatch: agent is on C, hint says B.
        const mismatch = await fleetTry(harness.clients.A, "fleet_send_prompt", {
          agentId,
          host: "B",
          prompt: "wrong host",
          mode: "steer",
        });
        expect(mismatch.ok).toBe(false);
        expect(mismatch.error ?? "").toMatch(/is on host "C", not "B"/);

        // C stopped → the fleet-index guidance names C as unreachable (the
        // index-based bare-id tools surface buildUnknownGuidance; the
        // fleet_send_prompt rejection uses the resolver error instead).
        await harness.daemons.C.daemon.stop();
        await waitFor(peerOffline(harness, "C"), (unreachable) => unreachable === true, {
          timeoutMs: 20_000,
          label: "peer C offline on A",
        });
        const unreachable = await fleetTry(harness.clients.A, "fleet_get_agent_activity", {
          agentId,
        });
        expect(unreachable.ok).toBe(false);
        expect(unreachable.error ?? "").toMatch(/C unreachable|unreachable/i);
      } finally {
        await harness.close();
      }
    },
  );
});

/** Predicate factory: a roster row on the commander host in the given workspace. */
function findAgentInWorkspace(
  harness: FleetHarness,
  workspaceId: string,
): () => Promise<FleetAgentRow | null> {
  return async () => {
    const payload = await fleetExec(harness.clients.A, "fleet_list_agents", { limit: 200 }).catch(
      () => null,
    );
    if (!payload || !Array.isArray(payload.agents)) {
      return null;
    }
    return (payload.agents as FleetAgentRow[]).find(
      (row) => row.workspaceId === workspaceId && row.host === "B",
    );
  };
}

describe("03 fail-fast spawn", () => {
  test(
    "bad workspaceId lists candidates; relative cwd errors; valid wks_ on B lands the agent in that workspace",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        const bWs = await harness.clients.B.createWorkspace({
          source: { kind: "directory", path: harness.daemons.B.paseoHomeRoot },
          title: "B workspace",
        });
        const bWsId = (bWs as { workspace?: { id?: string } }).workspace?.id;
        expect(bWsId).toBeTruthy();

        // Unknown workspace id on B: call-time error listing live candidates.
        const badWs = await fleetTry(harness.clients.A, "fleet_create_agent", {
          host: "B",
          workspaceId: "wks_ffffffffffffffff",
          provider: "claude/test-model",
          initialPrompt: "nope",
          title: "Bad workspace",
        });
        expect(badWs.ok).toBe(false);
        expect(badWs.error ?? "").toMatch(/workspace not found/i);
        expect(badWs.error ?? "").toMatch(/available workspaces/i);

        // Relative cwd: call-time rejection.
        const relCwd = await fleetTry(harness.clients.A, "fleet_create_agent", {
          host: "B",
          cwd: "relative/path",
          provider: "claude/test-model",
          initialPrompt: "nope",
          title: "Relative cwd",
        });
        expect(relCwd.ok).toBe(false);
        expect(relCwd.error ?? "").toMatch(/absolute/i);

        // Valid workspace on B: the agent lands in it.
        const spawn = await fleetTry(harness.clients.A, "fleet_create_agent", {
          workspaceId: bWsId,
          provider: "claude/test-model",
          initialPrompt: "Placed worker",
          title: "Placed worker",
        });
        expect(spawn.ok).toBe(true);
        const placedRow = await waitFor(
          findAgentInWorkspace(harness, bWsId as string),
          (row) => Boolean(row),
          { timeoutMs: 30_000, label: `agent in workspace ${bWsId} on B` },
        );
        expect(placedRow?.workspaceId).toBe(bWsId);
      } finally {
        await harness.close();
      }
    },
  );
});

describe("04 meta split — peer targets", () => {
  test(
    "rename agent/workspace/project round-trip on C; id-family validation errors",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        // State on C: an agent in a workspace.
        const cWs = await harness.clients.C.createWorkspace({
          source: { kind: "directory", path: harness.daemons.C.paseoHomeRoot },
          title: "Meta workspace",
        });
        const cWsId = cWs.workspace?.id;
        expect(cWsId).toBeTruthy();
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "C",
          provider: "claude/test-model",
          initialPrompt: "Meta worker",
          title: "Meta worker",
          workspaceId: cWsId as string,
        });

        // fleet_rename_agent_title → title on C.
        await applyMeta(harness, "fleet_rename_agent_title", {
          agentId,
          title: "Meta renamed",
          host: "C",
        });
        await waitForAgentRow(harness.clients.C, agentId, (r) => r.title === "Meta renamed", {
          label: "title",
        });

        // fleet_rename_workspace → title on C.
        await applyMeta(harness, "fleet_rename_workspace", {
          workspaceId: cWsId,
          title: "Renamed ws",
          host: "C",
        });
        const wsAfter = await harness.clients.C.fetchWorkspaces({ page: { limit: 200 } });
        expect(
          wsAfter.entries.some((w) => w.id === cWsId && (w.title ?? w.name) === "Renamed ws"),
        ).toBe(true);

        // fleet_create_project on C → project exists on C.
        const projRoot = `${harness.daemons.C.paseoHomeRoot}/new-proj`;
        await applyMeta(harness, "fleet_create_project", {
          host: "C",
          path: projRoot,
          title: "Created project",
        });
        const inv = await fleetExec(harness.clients.A, "fleet_list_inventory", { host: "C" });
        const hosts = inv.hosts as { host: string; projects: { id: string; title: string }[] }[];
        expect(hosts[0]!.projects.some((p) => p.title === "Created project")).toBe(true);

        // fleet_move_agent on C → agent workspace moves.
        const ws2Path = `${harness.daemons.C.paseoHomeRoot}/ws2`;
        await mkdir(ws2Path, { recursive: true });
        const cWs2 = await harness.clients.C.createWorkspace({
          source: { kind: "directory", path: ws2Path },
          title: "Second ws",
        });
        const cWs2Id = cWs2.workspace?.id;
        console.log("cWs2 result:", JSON.stringify(cWs2), "cWs2Id:", cWs2Id);
        expect(cWs2Id).toBeTruthy();
        await applyMeta(harness, "fleet_move_agent", { agentId, workspaceId: cWs2Id, host: "C" });
        const movedAgent = await waitForAgentRow(
          harness.clients.C,
          agentId,
          (r) => r.workspaceId === cWs2Id,
          {
            label: "moved agent workspace",
          },
        );
        expect(movedAgent.workspaceId).toBe(cWs2Id);

        // fleet_promote_workspace on C (requires experiments workspace).
        const expProjPath = `${harness.daemons.C.paseoHomeRoot}/experiments`;
        await applyMeta(harness, "fleet_create_project", {
          host: "C",
          path: expProjPath,
          title: "experiments",
        });
        const invBeforePromote = await fleetExec(harness.clients.A, "fleet_list_inventory", {
          host: "C",
        });
        const expProj = (
          invBeforePromote.hosts as { projects: { id: string; title: string }[] }[]
        )[0]?.projects.find((p) => p.title === "experiments");
        expect(expProj?.id).toBeTruthy();
        const expWsPath = `${expProjPath}/exp1`;
        await mkdir(expWsPath, { recursive: true });
        const expWs = await harness.clients.C.createWorkspace({
          source: { kind: "directory", path: expWsPath, projectId: expProj!.id },
          title: "Experiment 1",
        });
        const expWsId = expWs.workspace?.id;
        expect(expWsId).toBeTruthy();
        await applyMeta(harness, "fleet_promote_workspace", { workspaceId: expWsId, host: "C" });
        await applyMeta(harness, "fleet_archive_agent", { agentId, host: "C" });
        const archivedAgents = await harness.clients.C.fetchAgents({
          filter: { includeArchived: true },
        });
        const archAgentEntry = archivedAgents.entries.find((e) => e.agent.id === agentId);
        expect(archAgentEntry?.agent.archivedAt).toBeTruthy();

        // fleet_archive_workspace on C → workspace archived on C:
        // the live workspace list (fetchWorkspaces has no archived filter)
        // must no longer contain it.
        await applyMeta(harness, "fleet_archive_workspace", { workspaceId: cWs2Id, host: "C" });
        const liveWs = await harness.clients.C.fetchWorkspaces({ page: { limit: 200 } });
        expect(liveWs.entries.find((w) => w.id === cWs2Id)).toBeUndefined();

        // fleet_archive_project on C → project archived on C.
        const invC = await fleetExec(harness.clients.A, "fleet_list_inventory", { host: "C" });
        const cProjects = (invC.hosts as { projects: { id: string }[] }[])[0]?.projects ?? [];
        const cProjId = cProjects[0]?.id;
        if (cProjId) {
          await applyMeta(harness, "fleet_archive_project", { projectId: cProjId, host: "C" });
        }

        // Id-family validation errors: a title passed as agentId / workspaceId.
        const badAgent = await fleetTry(harness.clients.A, "fleet_rename_agent_title", {
          agentId: "Meta worker",
          title: "x",
        });
        expect(badAgent.ok).toBe(false);
        expect(badAgent.error ?? "").toMatch(/agentId must be an agent UUID/i);
        const badWs = await fleetTry(harness.clients.A, "fleet_rename_workspace", {
          workspaceId: "Meta workspace",
          title: "x",
        });
        expect(badWs.ok).toBe(false);
        expect(badWs.error ?? "").toMatch(/workspaceId must be a workspace id/i);
        const badPrj = await fleetTry(harness.clients.A, "fleet_rename_project", {
          projectId: "prj_nothex",
          title: "x",
        });
        expect(badPrj.ok).toBe(false);
        expect(badPrj.error ?? "").toMatch(/projectId must be a project id/i);
      } finally {
        await harness.close();
      }
    },
  );
});

describe("unarchive — peer targets", () => {
  test(
    "fleet_unarchive_workspace and fleet_unarchive_agent from A restore an archived workspace and agent on C",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        const wsPath = `${harness.daemons.C.paseoHomeRoot}/unarchive-ws`;
        await mkdir(wsPath, { recursive: true });
        const created = await harness.clients.C.createWorkspace({
          source: { kind: "directory", path: wsPath },
          title: "Unarchive ws",
        });
        const workspaceId = created.workspace?.id;
        expect(workspaceId).toBeTruthy();
        const { agentId } = await spawnWorker({
          from: harness.clients.A,
          host: "C",
          provider: "claude/test-model",
          initialPrompt: "unarchive worker",
          title: "Unarchive worker",
          workspaceId: workspaceId as string,
        });
        await waitForEvent(
          harness.clients.C,
          (e) => e.agentId === agentId && e.kind === "finished",
          { label: "unarchive worker finished on C" },
        );

        // Archiving the workspace on C archives its agent with it.
        await harness.clients.C.archiveWorkspace(workspaceId as string);
        expect((await harness.clients.C.fetchAgent(agentId))?.agent.archivedAt).toBeTruthy();

        // Archived workspaces on a peer are not in the fleet index: pass host.
        const workspace = await fleetExec(harness.clients.A, "fleet_unarchive_workspace", {
          workspaceId,
          host: "C",
        });
        expect(workspace).toMatchObject({
          ok: true,
          host: "C",
          workspaceId,
          restoredWorkspace: true,
          unarchivedAgentIds: [agentId],
        });
        expect((await harness.clients.C.fetchAgent(agentId))?.agent.archivedAt).toBeNull();
        const liveWorkspaces = await harness.clients.C.fetchWorkspaces({ page: { limit: 200 } });
        expect(liveWorkspaces.entries.some((entry) => entry.id === workspaceId)).toBe(true);

        // An agent archived on its own comes back by bare id.
        await harness.clients.C.archiveAgent(agentId);
        const agent = await fleetExec(harness.clients.A, "fleet_unarchive_agent", { agentId });
        expect(agent).toMatchObject({ ok: true, host: "C", agentId, unarchived: true });
        expect((await harness.clients.C.fetchAgent(agentId))?.agent.archivedAt).toBeNull();
      } finally {
        await harness.close();
      }
    },
  );
});

/** Run a meta tool from A over /mcp/fleet; it applies on the target host. */
async function applyMeta(
  harness: FleetHarness,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await fleetExec(harness.clients.A, tool, args);
  expect(result).toMatchObject({ ok: true, status: "applied" });
  return result;
}
