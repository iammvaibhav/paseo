import fsp from "node:fs/promises";
import path from "node:path";

export const meta = {
  name: "fleet-cross-host",
  tier: "fleet",
  hosts: 2,
  video: false,
  description:
    "Verifies cross-host peering, inventory aggregation, proof media proxying, and central config sync across commander and peer daemons.",
};

/**
 * Poll a predicate until truthy or timeout expires.
 */
async function pollUntil(
  predicate,
  { timeoutMs = 10000, intervalMs = 100, description = "condition" } = {},
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

// 1x1 valid PNG image buffer
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SAMPLE_PNG_BUFFER = Buffer.from(SAMPLE_PNG_BASE64, "base64");

let createdWorkspaceId = null;
const WORKSPACE_TITLE = "cross-host-peer-workspace";

export const steps = [
  {
    id: "mutual-peering",
    label: "Verify bidirectional peering status between commander and peer-b",
    narrate: "Peering link verified online from both commander and peer daemon perspectives.",
    async run(ctx) {
      const commanderClient = ctx.host("commander").client;
      const peerBClient = ctx.host("peer-b").client;

      // 1. Verify commander sees peer-b as online
      const commanderPeers = await pollUntil(
        async () => {
          const res = await commanderClient.missionControlPeersList();
          const peer = res.peers?.find((p) => p.name === "peer-b");
          return peer?.state === "online" ? res.peers : null;
        },
        { description: 'commander to report peer "peer-b" with state "online"' },
      );
      ctx.expect(Boolean(commanderPeers), "Commander sees peer-b in peers list");

      // 2. Verify peer-b sees commander as online (bidirectional proof)
      const peerBPeers = await pollUntil(
        async () => {
          const res = await peerBClient.missionControlPeersList();
          const peer = res.peers?.find((p) => p.name === "commander");
          return peer?.state === "online" ? res.peers : null;
        },
        { description: 'peer-b to report peer "commander" with state "online"' },
      );
      ctx.expect(Boolean(peerBPeers), "Peer-b sees commander in peers list");

      return "commander and peer-b mutual peering online";
    },
  },
  {
    id: "cross-host-inventory",
    label: "Aggregate fleet inventory with correct host locality tagging",
    narrate: "Workspace created on peer-b is visible on commander under peer-b host.",
    async run(ctx) {
      const commanderClient = ctx.host("commander").client;
      const peerBClient = ctx.host("peer-b").client;
      const peerBHome = ctx.host("peer-b").home;

      // 1. Create a workspace directly on peer-b
      const createRes = await peerBClient.createWorkspace({
        source: {
          kind: "directory",
          path: peerBHome,
        },
        title: WORKSPACE_TITLE,
      });
      createdWorkspaceId = createRes.workspace?.id;
      ctx.expect(Boolean(createdWorkspaceId), "Workspace created on peer-b with an id");

      // 2. Query fleet inventory from commander through the fleet_list_inventory tool
      const inventoryHosts = await pollUntil(
        async () => {
          const toolRes = await commanderClient.missionControlToolsExecute({
            name: "fleet_list_inventory",
            args: {},
          });
          if (!toolRes.ok || !toolRes.structuredContent?.hosts) {
            return null;
          }
          const hosts = toolRes.structuredContent.hosts;
          const peerBEntry = hosts.find((h) => h.host === "peer-b");
          const hasWorkspace = peerBEntry?.projects?.some((p) =>
            p.workspaces?.some((w) => w.id === createdWorkspaceId || w.title === WORKSPACE_TITLE),
          );
          return hasWorkspace ? hosts : null;
        },
        {
          description: `commander fleet_list_inventory to reflect workspace ${createdWorkspaceId} on peer-b`,
        },
      );

      ctx.expect(Array.isArray(inventoryHosts), "fleet_list_inventory returned hosts array");

      const commanderEntry = inventoryHosts.find(
        (h) => h.host === "commander" || h.host === "local",
      );
      const peerBEntry = inventoryHosts.find((h) => h.host === "peer-b");

      ctx.expect(Boolean(peerBEntry), 'Inventory includes "peer-b" host entry');
      ctx.expect(peerBEntry.reachable === true, "peer-b entry is marked reachable");

      // Assert workspace is present on peer-b
      const peerBWorkspaces = peerBEntry.projects.flatMap((p) => p.workspaces || []);
      const foundOnPeerB = peerBWorkspaces.find((w) => w.id === createdWorkspaceId);
      ctx.expect(Boolean(foundOnPeerB), `Workspace ${createdWorkspaceId} found under peer-b`);
      ctx.expect(
        foundOnPeerB.title === WORKSPACE_TITLE,
        `Workspace title matches ${WORKSPACE_TITLE}`,
      );

      // Assert workspace is NOT attributed to commander (host locality invariant)
      if (commanderEntry) {
        const commanderWorkspaces = (commanderEntry.projects || []).flatMap(
          (p) => p.workspaces || [],
        );
        const foundOnCommander = commanderWorkspaces.find((w) => w.id === createdWorkspaceId);
        ctx.expect(
          !foundOnCommander,
          `Workspace ${createdWorkspaceId} must NOT be attributed to commander host`,
        );
      }

      return `workspace ${createdWorkspaceId} correctly attributed to peer-b on commander inventory`;
    },
  },
  {
    id: "cross-host-media-proxy",
    label: "Proxy proof media from peer-b across daemon peering link",
    narrate: "Proof media file on peer-b fetched through commander media proxy RPC.",
    async run(ctx) {
      const commanderClient = ctx.host("commander").client;
      const peerBHome = ctx.host("peer-b").home;

      const mediaFileName = "proof-sample.png";
      const mediaFilePath = path.join(peerBHome, mediaFileName);
      await fsp.writeFile(mediaFilePath, SAMPLE_PNG_BUFFER);

      // 1. Fetch media from commander specifying host: "peer-b"
      const fetchRes = await commanderClient.missionControlMediaFetch({
        host: "peer-b",
        path: mediaFilePath,
      });

      ctx.expect(fetchRes.ok === true, `Media fetch returned ok:true (error: ${fetchRes.error})`);
      ctx.expect(
        fetchRes.mimeType === "image/png",
        `MIME type image/png expected, got ${fetchRes.mimeType}`,
      );
      ctx.expect(
        fetchRes.sizeBytes === SAMPLE_PNG_BUFFER.length,
        `Size ${SAMPLE_PNG_BUFFER.length} bytes expected`,
      );
      ctx.expect(
        fetchRes.data === SAMPLE_PNG_BASE64,
        "Base64 data matches expected sample PNG payload",
      );

      // 2. Negative check: relative paths must be rejected
      const relativeRes = await commanderClient.missionControlMediaFetch({
        host: "peer-b",
        path: "relative/path.png",
      });
      ctx.expect(relativeRes.ok === false, "Relative path must fail");
      ctx.expect(
        relativeRes.error?.includes("Proof path must be absolute") === true,
        `Expected "Proof path must be absolute", got ${relativeRes.error}`,
      );

      // 3. Negative check: unconfigured peer host must be rejected
      const invalidHostRes = await commanderClient.missionControlMediaFetch({
        host: "unknown-peer-host",
        path: mediaFilePath,
      });
      ctx.expect(invalidHostRes.ok === false, "Unknown peer host must fail");
      ctx.expect(
        invalidHostRes.error?.includes("not a configured peer") === true,
        `Expected "not a configured peer", got ${invalidHostRes.error}`,
      );

      return `media proxied (${SAMPLE_PNG_BUFFER.length} bytes, image/png) and security invariants verified`;
    },
  },
  {
    id: "central-config-sync",
    label: "Replicate central configuration patch from commander to peer-b",
    narrate: "Central configuration patched on commander and automatically replicated to peer-b.",
    async run(ctx) {
      const commanderClient = ctx.host("commander").client;
      const peerBClient = ctx.host("peer-b").client;

      const targetStatusNudge = 220;
      const targetNamingTheme = "space";

      // 1. Patch central config on commander (the designated owner)
      const patchRes = await commanderClient.missionControlConfigPatch({
        statusNudgeSeconds: targetStatusNudge,
        namingTheme: targetNamingTheme,
      });
      ctx.expect(
        patchRes.ok === true,
        `Central config patch succeeded on commander: ${patchRes.error}`,
      );

      // 2. Poll peer-b to ensure the replica was pushed over peering
      const peerBConfig = await pollUntil(
        async () => {
          const res = await peerBClient.missionControlConfigGet();
          const cfg = res.config;
          if (
            cfg &&
            cfg.statusNudgeSeconds === targetStatusNudge &&
            cfg.namingTheme === targetNamingTheme
          ) {
            return cfg;
          }
          return null;
        },
        {
          description: `peer-b to receive central-config replica with statusNudgeSeconds=${targetStatusNudge}`,
        },
      );

      ctx.expect(Boolean(peerBConfig), "peer-b received replicated central config");
      ctx.expect(
        peerBConfig.statusNudgeSeconds === targetStatusNudge,
        "statusNudgeSeconds matches on peer-b",
      );
      ctx.expect(peerBConfig.namingTheme === targetNamingTheme, "namingTheme matches on peer-b");

      return `central config replicated to peer-b (statusNudgeSeconds: ${targetStatusNudge}, namingTheme: ${targetNamingTheme})`;
    },
  },
  {
    id: "cross-host-spawn-labels",
    label: "Resolve spawn labels on peer-b across daemon RPC",
    narrate: "Target workspace labels resolved on peer daemon registry.",
    async run(ctx) {
      const peerBClient = ctx.host("peer-b").client;

      ctx.expect(Boolean(createdWorkspaceId), "Existing workspaceId from previous step available");

      // 1. Resolve labels for existing workspace on peer-b
      const wsLabelsRes = await peerBClient.missionControlSpawnLabelsResolve({
        workspaceId: createdWorkspaceId,
      });
      ctx.expect(
        wsLabelsRes.labels?.workspace === WORKSPACE_TITLE,
        `Expected workspace label "${WORKSPACE_TITLE}", got "${wsLabelsRes.labels?.workspace}"`,
      );

      // 2. Resolve labels for a new workspace path on peer-b
      const sampleNewDir = "/tmp/sample-peer-project";
      const newDirLabelsRes = await peerBClient.missionControlSpawnLabelsResolve({
        cwd: sampleNewDir,
      });
      ctx.expect(
        newDirLabelsRes.labels?.newProject === "sample-peer-project",
        `Expected newProject label "sample-peer-project", got "${newDirLabelsRes.labels?.newProject}"`,
      );

      return "workspace and project spawn labels resolved on peer-b registry";
    },
  },
];
