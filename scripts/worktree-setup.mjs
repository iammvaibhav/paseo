#!/usr/bin/env node
// Fast-worktree dependency sharing: symlink the source checkout's node_modules
// into this worktree when the lockfile matches, else run a real npm ci.
//
// Worktree setup used to run `npm ci` in every worktree — ~2.2G of
// node_modules and minutes of network per worktree, multiplied by the number
// of worktrees. Sharing the source checkout's tree makes setup seconds and
// adds ~0 disk per worktree.
//
// Ownership rule: the source checkout owns node_modules. Never run
// `npm install` / `npm ci` inside a worktree — it rewrites the shared tree and
// breaks every other worktree sharing it. If a branch changes dependencies,
// the lockfile stops matching and this script falls back to an independent
// npm ci for that worktree.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const sourceRoot = process.env.PASEO_SOURCE_CHECKOUT_PATH;
const worktreeRoot = process.env.PASEO_WORKTREE_PATH || process.cwd();

if (!sourceRoot || sourceRoot === worktreeRoot) {
  process.exit(0); // main checkout or unknown context — nothing to share
}

const SKIP_DIRS = new Set([
  ".git",
  ".dev",
  "dist",
  "build",
  "release",
  "coverage",
  ".expo",
  ".turbo",
]);

function lockfilesMatch() {
  const sourceLock = join(sourceRoot, "package-lock.json");
  const worktreeLock = join(worktreeRoot, "package-lock.json");
  if (!existsSync(sourceLock) || !existsSync(worktreeLock)) return false;
  return readFileSync(sourceLock).equals(readFileSync(worktreeLock));
}

function findNodeModulesDirs(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") {
        found.push(join(dir, entry.name));
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}

const sourceNodeModules = findNodeModulesDirs(sourceRoot);

if (!lockfilesMatch() || sourceNodeModules.length === 0) {
  console.log(
    "Worktree deps: lockfile differs from source or source has no node_modules — running npm ci",
  );
  execFileSync("npm", ["ci"], { cwd: worktreeRoot, stdio: "inherit" });
  process.exit(0);
}

let linked = 0;
let keptIndependent = 0;
for (const sourceDir of sourceNodeModules) {
  const rel = relative(sourceRoot, sourceDir);
  const target = join(worktreeRoot, rel);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) continue; // already shared
    keptIndependent += 1; // real dir from a previous npm ci — leave it alone
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(sourceDir, target, "dir");
  linked += 1;
}

if (keptIndependent > 0) {
  console.log(`Worktree deps: kept ${keptIndependent} existing node_modules dir(s) independent`);
}
console.log(
  linked > 0
    ? `Worktree deps: shared ${linked} node_modules dir(s) from ${sourceRoot}`
    : "Worktree deps: already shared",
);
