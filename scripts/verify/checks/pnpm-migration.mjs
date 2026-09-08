import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const meta = {
  name: "pnpm-migration",
  tier: "daemon",
  hosts: 0,
  video: false,
  description:
    "Asserts the repo uses pnpm workspaces: lockfile, config, install, build, and daemon entrypoint imports resolve under pnpm.",
};

export const steps = [
  {
    id: "lockfile-and-config",
    label: "pnpm-lock.yaml and pnpm-workspace.yaml present; package-lock.json absent",
    narrate: "Migration artifacts are in place.",
    async run(ctx) {
      const root = process.cwd();
      ctx.expect(existsSync(join(root, "pnpm-lock.yaml")), "pnpm-lock.yaml exists");
      ctx.expect(existsSync(join(root, "pnpm-workspace.yaml")), "pnpm-workspace.yaml exists");
      ctx.expect(!existsSync(join(root, "package-lock.json")), "package-lock.json deleted");
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      ctx.expect(
        typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@"),
        `packageManager field present: ${pkg.packageManager}`,
      );
      const workspaceYaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
      ctx.expect(
        workspaceYaml.includes("minimumReleaseAge:"),
        "minimumReleaseAge supply-chain policy set",
      );
      ctx.expect(workspaceYaml.includes("allowBuilds:"), "allowBuilds configured");
      return "lockfile, config, packageManager, policy all present";
    },
  },
  {
    id: "no-npm-refs",
    label: "No stale npm lockfiles or setup scripts remain",
    narrate: "npm-era artifacts are cleaned up.",
    async run(ctx) {
      const root = process.cwd();
      ctx.expect(!existsSync(join(root, "package-lock.json")), "root package-lock.json absent");
      ctx.expect(!existsSync(join(root, "scripts/npm-retry.mjs")), "scripts/npm-retry.mjs absent");
      ctx.expect(
        !existsSync(join(root, "scripts/worktree-setup.mjs")),
        "scripts/worktree-setup.mjs absent",
      );
      ctx.expect(
        existsSync(join(root, "scripts/pnpm-retry.mjs")),
        "scripts/pnpm-retry.mjs present",
      );
      return "stale npm artifacts removed, pnpm scripts in place";
    },
  },
  {
    id: "pnpm-install",
    label: "pnpm install --frozen-lockfile succeeds",
    narrate: "Lockfile is up to date and install resolves cleanly.",
    async run(_ctx) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("pnpm", ["install", "--frozen-lockfile"], {
        cwd: process.cwd(),
        stdio: "pipe",
        timeout: 120_000,
      });
      return "pnpm install --frozen-lockfile passed";
    },
  },
  {
    id: "server-build",
    label: "Server stack builds under pnpm",
    narrate: "Server and CLI packages compile successfully.",
    async run(_ctx) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("pnpm", ["run", "build:server"], {
        cwd: process.cwd(),
        stdio: "pipe",
        timeout: 300_000,
      });
      return "pnpm run build:server passed";
    },
  },
  {
    id: "daemon-module",
    label: "Daemon entrypoint module imports resolve cleanly",
    narrate: "All ESM imports in the supervisor entrypoint resolve without ERR_MODULE_NOT_FOUND.",
    async run(ctx) {
      const supervisor = join(
        process.cwd(),
        "packages/server/dist/scripts/supervisor-entrypoint.js",
      );
      ctx.expect(existsSync(supervisor), `supervisor exists at ${supervisor}`);

      // Run the import in a SUBPROCESS, not in-process: the real supervisor
      // module calls process.exit() once its startup sequence completes (or
      // detects an existing daemon), which would otherwise kill this whole
      // verify runner before it can record results.
      const { spawnSync } = await import("node:child_process");
      const probeScript = `
        import(${JSON.stringify(supervisor)})
          .then(() => { console.log("IMPORT_OK"); })
          .catch((e) => {
            console.error("IMPORT_FAIL", e.code || "", e.message || String(e));
            process.exitCode = 1;
          });
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
      });
      const stdout = result.stdout || "";
      const stderr = result.stderr || "";
      ctx.log(`stdout: ${stdout.trim().slice(0, 300)}`);
      if (stderr.trim()) ctx.log(`stderr: ${stderr.trim().slice(0, 300)}`);

      // Success criteria: either the module imported clean, or it got far
      // enough to hit the "already running" daemon-lock check (which only
      // runs after every import in the module graph has resolved).
      const moduleGraphIntact = stdout.includes("IMPORT_OK") || stderr.includes("already running");
      ctx.expect(
        moduleGraphIntact,
        `daemon module graph resolved (stdout: ${stdout.trim()}, stderr: ${stderr.trim().slice(0, 200)})`,
      );
      return "daemon module graph intact";
    },
  },
];
