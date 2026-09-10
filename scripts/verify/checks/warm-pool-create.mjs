import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  name: "warm-pool-create",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "After the git and OMP warm pools are stocked, a worktree workspace create and an omp/antigravity opus 4.6 agent create both finish in under a second.",
};

const WARM_BUDGET_MS = 1000;
const OPUS_MODEL = "google-antigravity/claude-opus-4-6";

function parseJsonLines(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // ignore non-json
    }
  }
  return rows;
}

function listWarmWorktrees(repoDir) {
  try {
    const out = execSync("git worktree list --porcelain", {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter((line) => line.startsWith("worktree ") && line.includes("/.warm-"))
      .map((line) => line.slice("worktree ".length));
  } catch {
    return [];
  }
}

async function pollFor(fetchValue, { timeoutMs = 60000, intervalMs = 200, description } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchValue();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${description} after ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

function latestMatching(logs, predicate) {
  for (let i = logs.length - 1; i >= 0; i--) {
    if (predicate(logs[i])) return logs[i];
  }
  return null;
}

export const steps = [
  {
    id: "prime-git-pool",
    label: "Cold-create one worktree workspace so the git warm pool restocks",
    narrate: "First worktree create may be cold; replenish then stocks an idle .warm-* tree.",
    async run(ctx) {
      const client = ctx.host().client;
      const fixture = ctx.fixtureRepo;
      ctx.expect(Boolean(fixture) && fs.existsSync(fixture), "Fixture repo exists");

      const first = await client.createWorkspace({
        source: {
          kind: "worktree",
          cwd: fixture,
          action: "checkout",
          refName: "main",
        },
        title: "warm-pool-prime",
      });
      ctx.expect(!first.error, `Prime workspace create failed: ${first.error}`);
      ctx.expect(Boolean(first.workspace?.id), "Prime workspace has an id");
      ctx.primeWorkspace = first.workspace;

      await pollFor(() => listWarmWorktrees(fixture).length > 0, {
        timeoutMs: 30000,
        description: "idle .warm-* worktree after prime create",
      });
      // Let the prime create's background git snapshot drain so the timed
      // claim is not queued behind status/for-each-ref.
      await new Promise((r) => setTimeout(r, 2500));
      return `primed ${first.workspace.id}; idle warm worktrees=${listWarmWorktrees(fixture).length}`;
    },
  },
  {
    id: "warm-workspace-create",
    label: "Claim a warm worktree workspace in under 1s",
    narrate: "Second worktree create must hit the git warm pool and finish in under a second.",
    async run(ctx) {
      const client = ctx.host().client;
      const t0 = Date.now();
      const created = await client.createWorkspace({
        source: {
          kind: "worktree",
          cwd: ctx.fixtureRepo,
          action: "checkout",
          refName: "main",
        },
        title: "warm-pool-claim",
      });
      const elapsedMs = Date.now() - t0;
      ctx.expect(!created.error, `Warm workspace create failed: ${created.error}`);
      ctx.expect(Boolean(created.workspace?.id), "Warm workspace has an id");
      ctx.expect(
        created.workspace.workspaceKind === "worktree" ||
          created.workspace.kind === "created_worktree" ||
          Boolean(created.workspace.workspaceDirectory),
        "Created workspace is a worktree",
      );
      ctx.warmWorkspace = created.workspace;
      ctx.workspaceCreateMs = elapsedMs;

      const logText = await ctx.readDaemonLog();
      const logs = parseJsonLines(logText);
      const claim = latestMatching(logs, (row) => row.msg === "Successfully claimed warm worktree");
      ctx.expect(Boolean(claim), "Daemon logged Successfully claimed warm worktree");
      ctx.expect(
        elapsedMs < WARM_BUDGET_MS,
        `Warm workspace.create took ${elapsedMs}ms, budget ${WARM_BUDGET_MS}ms (claim durationMs=${claim?.durationMs})`,
      );
      return `workspace ${created.workspace.id} in ${elapsedMs}ms claimDurationMs=${claim?.durationMs}`;
    },
  },
  {
    id: "prime-omp-pool",
    label: "Cold-create one omp agent so the OMP warm pool restocks",
    narrate: "First antigravity opus 4.6 create may cold-boot; the pool then keeps idle processes.",
    async run(ctx) {
      const client = ctx.host().client;
      const cwd = ctx.warmWorkspace?.workspaceDirectory || ctx.fixtureRepo;
      const agent = await client.createAgent({
        provider: "omp",
        model: OPUS_MODEL,
        cwd,
        workspaceId: ctx.warmWorkspace?.id,
        title: "warm-pool-omp-prime",
      });
      ctx.expect(Boolean(agent?.id), "Prime agent has an id");
      ctx.primeAgentId = agent.id;

      await pollFor(
        async () => {
          const logs = parseJsonLines(await ctx.readDaemonLog());
          return logs.some((row) => row.msg === "omp.runtime.acquire" && row.poolHit === false);
        },
        { timeoutMs: 60000, description: "cold omp.runtime.acquire log from prime create" },
      );
      // Two idle processes; one was just consumed. Wait until a replacement is live.
      await new Promise((r) => setTimeout(r, 2500));
      return `primed agent ${agent.id}`;
    },
  },
  {
    id: "warm-agent-create",
    label: "Claim an OMP warm-pool agent in under 1s",
    narrate: "Second opus 4.6 create must hit the OMP warm pool and finish in under a second.",
    async run(ctx) {
      const client = ctx.host().client;
      const cwd = ctx.warmWorkspace?.workspaceDirectory || ctx.fixtureRepo;
      const t0 = Date.now();
      const agent = await client.createAgent({
        provider: "omp",
        model: OPUS_MODEL,
        cwd,
        workspaceId: ctx.warmWorkspace?.id,
        title: "warm-pool-omp-claim",
      });
      const elapsedMs = Date.now() - t0;
      ctx.expect(Boolean(agent?.id), "Warm agent has an id");
      ctx.agentCreateMs = elapsedMs;
      ctx.warmAgentId = agent.id;

      const logs = parseJsonLines(await ctx.readDaemonLog());
      const acquire = latestMatching(
        logs,
        (row) =>
          row.msg === "omp.runtime.acquire" &&
          row.purpose === "create" &&
          typeof row.cwd === "string" &&
          path.resolve(row.cwd) === path.resolve(cwd),
      );
      ctx.expect(Boolean(acquire), "Daemon logged omp.runtime.acquire for the warm create");
      ctx.expect(
        acquire.poolHit === true,
        `Expected OMP pool hit, got poolHit=${acquire.poolHit} source=${acquire.source} totalMs=${acquire.totalMs}`,
      );
      ctx.expect(
        elapsedMs < WARM_BUDGET_MS,
        `Warm create_agent took ${elapsedMs}ms, budget ${WARM_BUDGET_MS}ms (acquire totalMs=${acquire.totalMs} claimMs=${acquire.claimMs})`,
      );
      return `agent ${agent.id} in ${elapsedMs}ms poolHit=${acquire.poolHit} claimMs=${acquire.claimMs} totalMs=${acquire.totalMs}`;
    },
  },
];
