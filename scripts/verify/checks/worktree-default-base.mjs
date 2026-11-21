import { execSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export const meta = {
  name: "worktree-default-base",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "A peer-style agent.create.request with a branch-off target and no base cuts the worktree from paseo.json worktree.warmPool.baseRef (local tip, ahead of origin) instead of origin's default branch, and claims the fresh warm tree with its setup reused.",
};

const BASE_REF = "custom";

function git(cwd, command) {
  return execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

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

async function pollFor(fetchValue, { timeoutMs, intervalMs = 500, description }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fetchValue();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

export const steps = [
  {
    id: "repo",
    label:
      "Repo whose origin default is main and whose warm-pool base is a local branch ahead of origin",
    narrate:
      "The fixture mirrors dev: origin/HEAD is a stale main, the configured base is ahead locally.",
    async run(ctx) {
      const root = path.join(ctx.artifactsDir, "default-base");
      const originDir = path.join(root, "origin.git");
      const repoDir = path.join(root, "repo");
      mkdirSync(repoDir, { recursive: true });
      execSync(`git init -q --bare -b main "${originDir}"`);
      git(repoDir, "init -q -b main");
      git(repoDir, "config user.name verify");
      git(repoDir, "config user.email verify@paseo.local");
      writeFileSync(
        path.join(repoDir, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: ["echo setup-ran >> setup.log"],
            warmPool: { enabled: true, targetIdle: 1, baseRef: BASE_REF },
          },
        }),
      );
      git(repoDir, "add paseo.json");
      git(repoDir, "commit -q -m 'paseo.json'");
      git(repoDir, `branch ${BASE_REF}`);
      writeFileSync(path.join(repoDir, "main-only.txt"), "stale default branch\n");
      git(repoDir, "add main-only.txt");
      git(repoDir, "commit -q -m 'main only'");
      git(repoDir, `remote add origin "${originDir}"`);
      git(repoDir, `push -q origin main ${BASE_REF}`);
      git(repoDir, "fetch -q origin");
      git(repoDir, "remote set-head origin main");
      // Landed locally, not yet pushed: the local base branch is ahead of origin's.
      git(repoDir, `checkout -q ${BASE_REF}`);
      writeFileSync(path.join(repoDir, "landed.txt"), "landed, not deployed\n");
      git(repoDir, "add landed.txt");
      git(repoDir, "commit -q -m 'landed locally'");
      git(repoDir, "checkout -q main");

      ctx.repoDir = realpathSync(repoDir);
      ctx.baseSha = git(repoDir, `rev-parse refs/heads/${BASE_REF}`);
      const originBaseSha = git(repoDir, `rev-parse refs/remotes/origin/${BASE_REF}`);
      ctx.expect(ctx.baseSha !== originBaseSha, "local base is ahead of origin's");
      return `repo ${ctx.repoDir}; local ${BASE_REF}=${ctx.baseSha.slice(0, 9)}, origin/${BASE_REF}=${originBaseSha.slice(0, 9)}`;
    },
  },
  {
    id: "warm-pool",
    label: "The warm pool provisions a tree at the configured base's local tip",
    narrate: "Opening the project lets the warm pool cut an idle tree.",
    async run(ctx) {
      const client = ctx.host().client;
      await client.openProject(ctx.repoDir);
      const provisioned = await pollFor(
        async () =>
          parseJsonLines(await ctx.readDaemonLog()).find(
            (row) =>
              row.msg === "Warm worktree provisioned successfully" && row.repoRoot === ctx.repoDir,
          ),
        { timeoutMs: 90_000, description: "a provisioned warm tree for the repo" },
      );
      ctx.expect(
        provisioned.baseSha === ctx.baseSha,
        `warm tree cut at ${provisioned.baseSha} (sourceRef ${provisioned.sourceRef}), expected local ${BASE_REF} ${ctx.baseSha}`,
      );
      ctx.warmPath = provisioned.warmWorktreePath;
      return `warm tree ${ctx.warmPath} at ${provisioned.baseSha.slice(0, 9)}`;
    },
  },
  {
    id: "peer-create",
    label: "agent.create.request with a branch-off target and no base claims the warm tree",
    narrate: "The peer create path names no base, so the configured base wins and setup is reused.",
    async run(ctx) {
      const client = ctx.host().client;
      const agent = await client.createAgent({
        provider: "omp",
        cwd: ctx.repoDir,
        title: "default-base-check",
        worktree: { mode: "branch-off", newBranch: "default-base-check" },
      });
      ctx.expect(Boolean(agent?.id), "agent created");
      const worktreeDir = agent.cwd;
      ctx.expect(
        typeof worktreeDir === "string" && worktreeDir !== ctx.repoDir,
        `agent runs in a new worktree (cwd ${worktreeDir})`,
      );
      const head = git(worktreeDir, "rev-parse HEAD");
      const claim = parseJsonLines(await ctx.readDaemonLog()).find(
        (row) => row.msg === "Successfully claimed warm worktree" && row.repoRoot === ctx.repoDir,
      );
      ctx.expect(
        head === ctx.baseSha,
        `worktree HEAD ${head} is local ${BASE_REF} ${ctx.baseSha} (origin/main is ${git(ctx.repoDir, "rev-parse origin/main")})`,
      );
      ctx.expect(Boolean(claim), "the create claimed the warm tree");
      ctx.expect(
        claim.worktreePath === ctx.warmPath,
        `claimed ${claim.worktreePath}, expected ${ctx.warmPath}`,
      );
      ctx.expect(claim.setupPrepared === true, `setupPrepared=${claim.setupPrepared}`);
      await client.archiveAgent(agent.id).catch(() => undefined);
      return `HEAD ${head.slice(0, 9)} = local ${BASE_REF}; claim setupPrepared=${claim.setupPrepared}`;
    },
  },
];
