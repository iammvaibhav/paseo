import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  name: "paseo45-diff-base-select",
  tier: "daemon",
  hosts: 1,
  video: false,
  description:
    "A worktree branched off feature-base defaults its base-branch diff to feature-base, " +
    "and honors an explicit baseRef override to diff against main instead.",
};

function repoDirFor(ctx) {
  return path.join(ctx.host().home, `paseo45-base-select-${ctx.stack.runId}`);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

export const steps = [
  {
    id: "build-fixture-repo",
    label: "Build a repo with main and a feature-base branch cut from it",
    narrate: "Fixture repo has main (commit A) and feature-base (commit B) branches.",
    async run(ctx) {
      const repoDir = repoDirFor(ctx);
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ["init", "-b", "main"]);
      git(repoDir, ["config", "user.email", "verify@paseo.dev"]);
      git(repoDir, ["config", "user.name", "Paseo Verify"]);
      git(repoDir, ["config", "commit.gpgsign", "false"]);

      fs.writeFileSync(path.join(repoDir, "a.txt"), "commit A\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "commit A"]);

      git(repoDir, ["checkout", "-b", "feature-base"]);
      fs.writeFileSync(path.join(repoDir, "b.txt"), "commit B\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "commit B"]);

      git(repoDir, ["checkout", "main"]);

      ctx.baseSelectRepo = repoDir;
      return `fixture repo at ${repoDir}: main(a.txt), feature-base(a.txt,b.txt), checked out on main`;
    },
  },
  {
    id: "create-worktree-branch-off",
    label: "Branch-off worktree from feature-base",
    narrate: "Worktree created from feature-base via workspace.create.",
    async run(ctx) {
      const client = ctx.host().client;
      const branchName = `paseo45-${ctx.stack.runId}`;
      const created = await client.createWorkspace({
        source: {
          kind: "worktree",
          cwd: ctx.baseSelectRepo,
          action: "branch-off",
          baseBranch: "feature-base",
          branchName,
          worktreeSlug: branchName,
        },
        title: "paseo45-base-select",
      });
      ctx.expect(!created.error, `Worktree create failed: ${created.error}`);
      ctx.expect(
        Boolean(created.workspace?.workspaceDirectory),
        "Worktree has a workspaceDirectory",
      );
      ctx.expect(
        created.workspace.gitRuntime?.currentBranch === branchName,
        `Expected current branch ${branchName}, got ${created.workspace.gitRuntime?.currentBranch}`,
      );
      ctx.worktreeDir = created.workspace.workspaceDirectory;
      return `worktree ${created.workspace.id} at ${ctx.worktreeDir} on branch ${branchName}`;
    },
  },
  {
    id: "default-base-is-cut-from-branch",
    label: "checkout_status defaults baseRef to feature-base",
    narrate: "Status reports the branch the worktree was cut from as its base.",
    async run(ctx) {
      const client = ctx.host().client;
      const status = await client.getCheckoutStatus(ctx.worktreeDir);
      ctx.expect(
        status.baseRef === "feature-base",
        `Expected default baseRef "feature-base", got ${JSON.stringify(status.baseRef)}`,
      );
      return `checkout_status.baseRef=${status.baseRef}`;
    },
  },
  {
    id: "commit-c-in-worktree",
    label: "Add commit C in the worktree",
    narrate: "A new commit lands on top of the branched-off worktree.",
    async run(ctx) {
      fs.writeFileSync(path.join(ctx.worktreeDir, "c.txt"), "commit C\n");
      git(ctx.worktreeDir, ["add", "-A"]);
      git(ctx.worktreeDir, ["commit", "-m", "commit C"]);
      return "commit C added on top of feature-base";
    },
  },
  {
    id: "default-base-diff-lists-only-c",
    label: "Default base diff (no baseRef) lists only c.txt",
    narrate: "Diffing against the default base shows only commit C's file.",
    async run(ctx) {
      const client = ctx.host().client;
      const result = await client.getCheckoutDiff(ctx.worktreeDir, { mode: "base" });
      ctx.expect(!result.error, `Default base diff failed: ${JSON.stringify(result.error)}`);
      const paths = result.files.map((f) => f.path);
      ctx.expect(
        paths.length === 1 && paths[0].endsWith("c.txt"),
        `Expected only c.txt in default base diff, got ${JSON.stringify(paths)}`,
      );
      return `default base diff files=${JSON.stringify(paths)}`;
    },
  },
  {
    id: "requested-base-override-diffs-against-main",
    label: "Requesting baseRef=main lists b.txt and c.txt",
    narrate: "An explicit baseRef override compares against a branch other than the stored base.",
    async run(ctx) {
      const client = ctx.host().client;
      const result = await client.getCheckoutDiff(ctx.worktreeDir, {
        mode: "base",
        baseRef: "main",
      });
      ctx.expect(
        !result.error,
        `Requested baseRef=main diff should succeed, got error: ${JSON.stringify(result.error)}`,
      );
      const paths = result.files.map((f) => f.path);
      ctx.expect(
        paths.some((p) => p.endsWith("b.txt")) && paths.some((p) => p.endsWith("c.txt")),
        `Expected b.txt and c.txt in baseRef=main diff, got ${JSON.stringify(paths)}`,
      );
      return `baseRef=main diff files=${JSON.stringify(paths)}`;
    },
  },
];
