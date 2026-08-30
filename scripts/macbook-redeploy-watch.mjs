#!/usr/bin/env node
// Deploy to the MacBook as soon as it comes back on the tunnel.
//
// The MacBook is a laptop behind NAT: its WireGuard endpoint goes stale while it
// sleeps, and nothing this host sends can bring the tunnel up — only the MacBook
// re-initiates. So its deploy job is reachability-gated and reports success by
// skipping, which is how it silently sat 3 commits behind while every other host
// was current. This closes that gap: check reachability on a schedule, and when
// it returns with a stale checkout, run the MacBook-only deploy.
//
// Deliberately NOT edge-triggered on "reconnected". The trigger is state, not a
// transition: deploy only when the MacBook's HEAD differs from the commit this
// host has pushed. That is idempotent (a tick during a current MacBook is a
// no-op), survives a missed tick, and cannot fire twice for one commit.
//
// A deploy quits and relaunches Paseo.app on the user's machine, so every guard
// here exists to avoid doing that at a bad moment or in a loop:
//   - never while another deploy is in flight (its pid file is alive),
//   - never twice for the same commit unless the previous attempt failed AND the
//     cooldown has passed, so a broken build cannot hammer the laptop,
//   - never when the local tree is dirty or unpushed: the MacBook pulls from
//     origin, so deploying then would ship something other than what was tested.
//
// Usage: node scripts/macbook-redeploy-watch.mjs
// Env:   PASEO_MACBOOK_HOST (default "macbook")
//        PASEO_MACBOOK_WATCH_COOLDOWN_MIN (default 30)
//        PASEO_MACBOOK_WATCH_DISABLED=1 to stop acting without removing the timer
import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_DIR = path.resolve(import.meta.dirname, "..");
const HOST = process.env.PASEO_MACBOOK_HOST || "macbook";
const COOLDOWN_MIN = Number(process.env.PASEO_MACBOOK_WATCH_COOLDOWN_MIN ?? 30);
const STATE_PATH = path.join(homedir(), ".paseo", "macbook-redeploy-watch.json");
const BRANCH = "vaibhav/customizations";

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STATE_PATH);
}

async function git(...args) {
  const { stdout } = await run("git", ["-C", REPO_DIR, ...args]);
  return stdout.trim();
}

/** Reachable means "ssh completes", not "ping answers": deploy needs ssh. */
async function macbookHead() {
  try {
    const { stdout } = await run(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        HOST,
        "cd ~/paseo && git rev-parse HEAD",
      ],
      { timeout: 30_000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/** A deploy already running owns the MacBook; never start a second one. */
function deployInFlight() {
  const pidFile = path.join(homedir(), ".paseo", "deploy-logs", "latest-run", "pid");
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.PASEO_MACBOOK_WATCH_DISABLED === "1") return;

  const head = await git("rev-parse", "HEAD");
  const remoteHead = await git("rev-parse", `refs/remotes/origin/${BRANCH}`).catch(() => null);

  // The MacBook pulls from origin, so this host's HEAD is only the right target
  // when it is actually the pushed commit and nothing is uncommitted.
  const dirty = (await git("status", "--porcelain")) !== "";
  if (dirty || head !== remoteHead) {
    log(`skip: local tree not publishable (dirty=${dirty}, head=${head.slice(0, 9)}, origin=${String(remoteHead).slice(0, 9)})`);
    return;
  }

  const macHead = await macbookHead();
  if (!macHead) return; // unreachable: the normal case while it sleeps, stay quiet
  if (macHead === head) {
    log(`up to date at ${head.slice(0, 9)}`);
    return;
  }

  if (deployInFlight()) {
    log("skip: a deploy is already in flight");
    return;
  }

  const state = readState();
  const attemptedAt = state.lastAttempt?.commit === head ? state.lastAttempt.at : null;
  if (attemptedAt) {
    const ageMin = (Date.now() - Date.parse(attemptedAt)) / 60_000;
    if (state.lastAttempt.ok || ageMin < COOLDOWN_MIN) {
      log(
        state.lastAttempt.ok
          ? `skip: already deployed ${head.slice(0, 9)} to ${HOST}; MacBook reports ${macHead.slice(0, 9)}`
          : `skip: ${head.slice(0, 9)} failed ${Math.round(ageMin)}m ago, cooling down (${COOLDOWN_MIN}m)`,
      );
      return;
    }
  }

  log(`${HOST} is back at ${macHead.slice(0, 9)}, deploying ${head.slice(0, 9)}`);
  writeState({ ...state, lastAttempt: { commit: head, at: new Date().toISOString(), ok: false } });

  try {
    // Same invocation a human would use for a MacBook-only deploy. deploy.sh
    // self-detaches, so this returns as soon as the child is launched; the
    // outcome lands in the deploy log, and the next tick sees the new HEAD.
    const env = { ...process.env, PASEO_SKIP_LOCAL: "1", PASEO_SKIP_REMOTES: "1" };
    for (const key of [
      "PASEO_DEPLOY_DETACHED",
      "PASEO_DEPLOY_RUN_DIR",
      "PASEO_DEPLOY_LOG",
      "PASEO_DEPLOY_FOREGROUND",
      "PASEO_DEPLOY_DETACH_TOKEN",
    ]) {
      delete env[key];
    }
    const { stdout } = await run("bash", [path.join(REPO_DIR, "scripts", "deploy.sh")], {
      cwd: REPO_DIR,
      env,
      timeout: 120_000,
    });
    log(`deploy launched: ${stdout.trim().split("\n").filter(Boolean).slice(0, 2).join(" | ")}`);
    writeState({ ...readState(), lastAttempt: { commit: head, at: new Date().toISOString(), ok: true } });
  } catch (error) {
    log(`deploy launch FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
