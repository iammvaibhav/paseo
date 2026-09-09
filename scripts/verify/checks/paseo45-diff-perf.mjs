import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  name: "paseo45-diff-perf",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "Checkout diff over a 1250-file changeset finishes within 5x native `git diff HEAD` " +
    "time (floor 1500ms), proving the Changes pane diff pipeline is as fast as native git.",
};

const FILE_COUNT = 1200;
const UNTRACKED_COUNT = 50;
const LINES_PER_FILE = 30;
const TOTAL_FILES = FILE_COUNT + UNTRACKED_COUNT;

function fileContent(seed) {
  const lines = [];
  for (let line = 0; line < LINES_PER_FILE; line++) {
    lines.push(`export const value${line} = ${seed};`);
  }
  return `${lines.join("\n")}\n`;
}

function repoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo45-diff-perf-${ctx.stack.runId}`);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

export const steps = [
  {
    id: "build-fixture",
    label: "Build a 1250-file fixture repo (1200 modified + 50 untracked)",
    narrate: "Fixture repo created with a large, realistic changeset.",
    async run(ctx) {
      const repoDir = repoDirFor(ctx);
      const srcDir = path.join(repoDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      for (let i = 0; i < FILE_COUNT; i++) {
        fs.writeFileSync(path.join(srcDir, `file-${i}.ts`), fileContent(i));
      }

      git(repoDir, ["init", "-b", "main"]);
      git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
      git(repoDir, ["config", "user.name", "Paseo Verify"]);
      git(repoDir, ["config", "commit.gpgsign", "false"]);
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "initial fixture commit"]);

      // Modify a few lines in every tracked file.
      for (let i = 0; i < FILE_COUNT; i++) {
        const updated = fileContent(i).replace("value0 =", "valueUpdated =");
        fs.writeFileSync(path.join(srcDir, `file-${i}.ts`), updated);
      }

      // Add untracked files so the diff also covers new-file discovery.
      for (let i = 0; i < UNTRACKED_COUNT; i++) {
        fs.writeFileSync(path.join(srcDir, `new-${i}.ts`), fileContent(10_000 + i));
      }

      ctx.perfRepo = repoDir;
      return `fixture built at ${repoDir}: ${FILE_COUNT} modified, ${UNTRACKED_COUNT} untracked`;
    },
  },
  {
    id: "cli-baseline",
    label: "Time native `git diff HEAD` (min of 3 runs)",
    narrate: "Native git diff timed three times as the speed budget baseline.",
    async run(ctx) {
      const repoDir = ctx.perfRepo;
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        execFileSync("git", ["diff", "HEAD"], {
          cwd: repoDir,
          stdio: ["ignore", "ignore", "ignore"],
        });
        best = Math.min(best, Date.now() - t0);
      }
      ctx.cliMs = best;
      return `cli baseline min=${best}ms over 3 runs`;
    },
  },
  {
    id: "checkout-diff-cold",
    label: "Cold checkout diff returns all 1250 changed files with hunks within budget",
    narrate: "First checkout diff call resolves every changed file with real hunks.",
    async run(ctx) {
      const client = ctx.host().client;
      const t0 = Date.now();
      const result = await client.getCheckoutDiff(ctx.perfRepo, { mode: "uncommitted" });
      ctx.coldMs = Date.now() - t0;
      ctx.expect(!result.error, `Cold checkout diff failed: ${JSON.stringify(result.error)}`);
      ctx.expect(
        result.files.length === TOTAL_FILES,
        `Expected ${TOTAL_FILES} changed files, got ${result.files.length}`,
      );
      const sample = result.files.find((f) => f.path.endsWith("file-0.ts"));
      ctx.expect(Boolean(sample), "Sample modified file file-0.ts present in diff");
      ctx.expect(sample.hunks.length > 0, "Sample file has non-empty hunks");
      const budget = Math.max(ctx.cliMs * 5, 1500);
      ctx.expect(
        ctx.coldMs <= budget,
        `Cold checkout diff took ${ctx.coldMs}ms, budget ${budget}ms (cli=${ctx.cliMs}ms x5, floor 1500ms)`,
      );
      return `cold checkout diff: ${result.files.length} files in ${ctx.coldMs}ms (budget ${budget}ms)`;
    },
  },
  {
    id: "checkout-diff-warm-budget",
    label: "Warm checkout diff is within budget of native git speed",
    narrate: "Warm checkout diff must not be dramatically slower than native git.",
    async run(ctx) {
      const client = ctx.host().client;
      const t0 = Date.now();
      const result = await client.getCheckoutDiff(ctx.perfRepo, { mode: "uncommitted" });
      const checkoutMs = Date.now() - t0;
      ctx.expect(!result.error, `Warm checkout diff failed: ${JSON.stringify(result.error)}`);
      ctx.expect(
        result.files.length === TOTAL_FILES,
        `Expected ${TOTAL_FILES} changed files on warm read, got ${result.files.length}`,
      );
      const budget = Math.max(ctx.cliMs * 5, 1500);
      ctx.expect(
        checkoutMs <= budget,
        `Warm checkout diff took ${checkoutMs}ms, budget ${budget}ms (cli=${ctx.cliMs}ms x5, floor 1500ms)`,
      );
      return `cli=${ctx.cliMs}ms checkout=${checkoutMs}ms`;
    },
  },
  {
    id: "checkout-diff-base-mode",
    label: "Base-mode diff against the repo's own branch succeeds",
    narrate: "Base comparison mode also resolves without error.",
    async run(ctx) {
      const client = ctx.host().client;
      const result = await client.getCheckoutDiff(ctx.perfRepo, {
        mode: "base",
        baseRef: "main",
      });
      ctx.expect(!result.error, `Base-mode diff failed: ${JSON.stringify(result.error)}`);
      return `base-mode diff against main resolved with ${result.files.length} files`;
    },
  },
];
