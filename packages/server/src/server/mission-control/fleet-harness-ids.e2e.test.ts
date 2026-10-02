import { mkdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createFleetHarness,
  fleetExec,
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
 * Layer 2 scenario group 2 — fleet ids (02), fail-fast spawn (03), dedupe
 * (03), meta split (04). Commander-host RPC surface only.
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

        // Bare-id send resolves WITHOUT a host hint → ask-mode proposal → approve routes over peering to C.
        const send = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_send_prompt",
          args: { agentId, prompt: "continue", mode: "steer" },
        });
        expect(send.ok).toBe(true);
        const sendProposalId = send.structuredContent?.proposalId as string | undefined;
        expect(sendProposalId).toBeTruthy();
        expect(send.structuredContent?.guidance ?? "").toMatch(/for approval/i);
        const approveSend = await harness.clients.A.missionControlProposalsRespond({
          proposalId: sendProposalId!,
          action: "approve",
        });
        expect(approveSend.ok).toBe(true);
        // Verify prompt landed on C (turn ran and finished).
        await waitForEvent(
          harness.clients.C,
          (e) => e.agentId === agentId && e.kind === "finished",
          {
            label: "peer send delivered and finished on C",
          },
        );
        // Bare-id meta rename → proposal → approve → title changes on C.
        const rename = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_rename_agent_title",
          args: { agentId, title: "Renamed from A" },
        });
        expect(rename.ok).toBe(true);
        const renameProposalId = rename.structuredContent?.proposalId as string | undefined;
        expect(renameProposalId).toBeTruthy();
        const approveRename = await harness.clients.A.missionControlProposalsRespond({
          proposalId: renameProposalId!,
          action: "approve",
        });
        expect(approveRename.ok).toBe(true);
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
        const mismatch = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_send_prompt",
          args: { agentId, host: "B", prompt: "wrong host", mode: "steer" },
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
        const unreachable = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_get_agent_activity",
          args: { agentId },
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
    "bad workspaceId lists candidates; relative cwd errors; valid wks_ on B → proposal → approve lands agent in that workspace",
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
        const badWs = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args: {
            host: "B",
            workspaceId: "wks_ffffffffffffffff",
            provider: "claude/test-model",
            initialPrompt: "nope",
            title: "Bad workspace",
          },
        });
        expect(badWs.ok).toBe(false);
        expect(badWs.error ?? "").toMatch(/workspace not found/i);
        expect(badWs.error ?? "").toMatch(/available workspaces/i);

        // Relative cwd: call-time rejection.
        const relCwd = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args: {
            host: "B",
            cwd: "relative/path",
            provider: "claude/test-model",
            initialPrompt: "nope",
            title: "Relative cwd",
          },
        });
        expect(relCwd.ok).toBe(false);
        expect(relCwd.error ?? "").toMatch(/absolute/i);

        // Valid workspace on B: proposal → approve → agent lands in it.
        const spawn = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args: {
            workspaceId: bWsId,
            provider: "claude/test-model",
            initialPrompt: "Placed worker",
            title: "Placed worker",
          },
        });
        expect(spawn.ok).toBe(true);
        const proposalId = spawn.structuredContent?.proposalId as string | undefined;
        expect(proposalId).toBeTruthy();
        const approve = await harness.clients.A.missionControlProposalsRespond({
          proposalId: proposalId!,
          action: "approve",
        });
        expect(approve.ok).toBe(true);
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

describe("03 dedupe", () => {
  test(
    "identical fleet_create_agent while pending → same proposalId; after resolve → new proposal allowed",
    { timeout: 240_000 },
    async () => {
      const harness = await createFleetHarness();
      try {
        const args = {
          host: "B",
          provider: "claude/test-model",
          initialPrompt: "Dedupe worker",
          title: "Dedupe worker",
          cwd: harness.daemons.B.paseoHomeRoot,
        };
        const first = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args,
        });
        expect(first.ok).toBe(true);
        const firstProposal = first.structuredContent?.proposalId as string | undefined;
        expect(firstProposal).toBeTruthy();

        // Identical call while pending: deduped onto the SAME proposal.
        const second = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args,
        });
        expect(second.ok).toBe(true);
        const secondProposal = second.structuredContent?.proposalId as string | undefined;
        expect(secondProposal).toBe(firstProposal);
        expect(second.structuredContent?.guidance ?? "").toMatch(/already pending/i);

        // Resolve → the dedupe window clears → a new identical call proposes fresh.
        const approve = await harness.clients.A.missionControlProposalsRespond({
          proposalId: firstProposal!,
          action: "approve",
        });
        expect(approve.ok).toBe(true);
        await waitForEvent(
          harness.clients.A,
          (e) =>
            e.kind === "proposal" &&
            e.proposal?.id === firstProposal &&
            e.proposal?.spawnedAgentId != null,
          {
            label: "spawn executed",
          },
        );
        const third = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_create_agent",
          args,
        });
        expect(third.ok).toBe(true);
        const thirdProposal = third.structuredContent?.proposalId as string | undefined;
        expect(thirdProposal).toBeTruthy();
        expect(thirdProposal).not.toBe(firstProposal);
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

        // fleet_rename_agent_title → approve → title on C.
        await approveMeta(harness, "fleet_rename_agent_title", {
          agentId,
          title: "Meta renamed",
          host: "C",
        });
        await waitForAgentRow(harness.clients.C, agentId, (r) => r.title === "Meta renamed", {
          label: "title",
        });

        // fleet_rename_workspace → approve → title on C.
        await approveMeta(harness, "fleet_rename_workspace", {
          workspaceId: cWsId,
          title: "Renamed ws",
          host: "C",
        });
        const wsAfter = await harness.clients.C.fetchWorkspaces({ page: { limit: 200 } });
        expect(
          wsAfter.entries.some((w) => w.id === cWsId && (w.title ?? w.name) === "Renamed ws"),
        ).toBe(true);

        // fleet_create_project on C → approve → project exists on C.
        const projRoot = `${harness.daemons.C.paseoHomeRoot}/new-proj`;
        const created = await approveMeta(harness, "fleet_create_project", {
          host: "C",
          path: projRoot,
          title: "Created project",
        });
        expect(created).toBe(true);
        const inv = await fleetExec(harness.clients.A, "fleet_list_inventory", { host: "C" });
        const hosts = inv.hosts as { host: string; projects: { id: string; title: string }[] }[];
        expect(hosts[0]!.projects.some((p) => p.title === "Created project")).toBe(true);

        // fleet_move_agent on C → approve → agent workspace moves.
        const ws2Path = `${harness.daemons.C.paseoHomeRoot}/ws2`;
        await mkdir(ws2Path, { recursive: true });
        const cWs2 = await harness.clients.C.createWorkspace({
          source: { kind: "directory", path: ws2Path },
          title: "Second ws",
        });
        const cWs2Id = cWs2.workspace?.id;
        console.log("cWs2 result:", JSON.stringify(cWs2), "cWs2Id:", cWs2Id);
        expect(cWs2Id).toBeTruthy();
        await approveMeta(harness, "fleet_move_agent", { agentId, workspaceId: cWs2Id, host: "C" });
        const movedAgent = await waitForAgentRow(
          harness.clients.C,
          agentId,
          (r) => r.workspaceId === cWs2Id,
          {
            label: "moved agent workspace",
          },
        );
        expect(movedAgent.workspaceId).toBe(cWs2Id);

        // fleet_adopt_agent on C → approve → commander adoption label stamped.
        await approveMeta(harness, "fleet_adopt_agent", { agentId, host: "C" });
        const adoptedAgent = await waitForAgentRow(
          harness.clients.C,
          agentId,
          (r) =>
            Boolean(
              (r.labels as Record<string, string> | undefined)?.["paseo.commander-adopted-at"],
            ),
          { label: "adopted agent" },
        );
        expect(
          (adoptedAgent.labels as Record<string, string>)?.["paseo.commander-adopted-at"],
        ).toBeTruthy();

        // fleet_release_agent on C → approve → commander adoption label cleared.
        await approveMeta(harness, "fleet_release_agent", { agentId, host: "C" });
        const releasedAgent = await waitForAgentRow(
          harness.clients.C,
          agentId,
          (r) => !(r.labels as Record<string, string> | undefined)?.["paseo.commander-adopted-at"],
          { label: "released agent" },
        );
        expect(
          (releasedAgent.labels as Record<string, string>)?.["paseo.commander-adopted-at"],
        ).toBeFalsy();

        // fleet_promote_workspace on C → approve (requires experiments workspace).
        const expProjPath = `${harness.daemons.C.paseoHomeRoot}/experiments`;
        await approveMeta(harness, "fleet_create_project", {
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
        await approveMeta(harness, "fleet_promote_workspace", { workspaceId: expWsId, host: "C" });
        await approveMeta(harness, "fleet_archive_agent", { agentId, host: "C" });
        const archivedAgents = await harness.clients.C.fetchAgents({
          filter: { includeArchived: true },
        });
        const archAgentEntry = archivedAgents.entries.find((e) => e.agent.id === agentId);
        expect(archAgentEntry?.agent.archivedAt).toBeTruthy();

        // fleet_archive_workspace on C → approve → workspace archived on C:
        // the live workspace list (fetchWorkspaces has no archived filter)
        // must no longer contain it.
        await approveMeta(harness, "fleet_archive_workspace", { workspaceId: cWs2Id, host: "C" });
        const liveWs = await harness.clients.C.fetchWorkspaces({ page: { limit: 200 } });
        expect(liveWs.entries.find((w) => w.id === cWs2Id)).toBeUndefined();

        // fleet_archive_project on C → approve → project archived on C.
        const invC = await fleetExec(harness.clients.A, "fleet_list_inventory", { host: "C" });
        const cProjects = (invC.hosts as { projects: { id: string }[] }[])[0]?.projects ?? [];
        const cProjId = cProjects[0]?.id;
        if (cProjId) {
          await approveMeta(harness, "fleet_archive_project", { projectId: cProjId, host: "C" });
        }

        // Id-family validation errors: a title passed as agentId / workspaceId.
        const badAgent = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_rename_agent_title",
          args: { agentId: "Meta worker", title: "x" },
        });
        expect(badAgent.ok).toBe(false);
        expect(badAgent.error ?? "").toMatch(/agentId must be an agent UUID/i);
        const badWs = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_rename_workspace",
          args: { workspaceId: "Meta workspace", title: "x" },
        });
        expect(badWs.ok).toBe(false);
        expect(badWs.error ?? "").toMatch(/workspaceId must be a workspace id/i);
        const badPrj = await harness.clients.A.missionControlToolsExecute({
          name: "fleet_rename_project",
          args: { projectId: "prj_nothex", title: "x" },
        });
        expect(badPrj.ok).toBe(false);
        expect(badPrj.error ?? "").toMatch(/projectId must be a project id/i);
      } finally {
        await harness.close();
      }
    },
  );
});

async function approveMeta(
  harness: FleetHarness,
  tool: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const exec = await harness.clients.A.missionControlToolsExecute({ name: tool, args });
  expect(exec.ok).toBe(true);
  const proposalId = exec.structuredContent?.proposalId as string | undefined;
  expect(proposalId).toBeTruthy();
  const respond = await harness.clients.A.missionControlProposalsRespond({
    proposalId: proposalId!,
    action: "approve",
  });
  if (!respond.ok) {
    console.log("approveMeta failed for", tool, "args:", args, "error:", respond.error);
  }
  expect(respond.ok).toBe(true);
  return true;
}
