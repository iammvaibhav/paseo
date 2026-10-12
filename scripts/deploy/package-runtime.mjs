#!/usr/bin/env node
// Package the built daemon runtime of THIS checkout into a versioned tarball
// that other hosts of the same platform can run without a checkout or a build.
//
// Run on a builder after `pnpm run build:server` + `pnpm run build:daemon-web-ui`:
//   node scripts/deploy/package-runtime.mjs [--out <dir>]
// or, for a checkout that predates this script, piped over ssh:
//   PASEO_REPO_DIR=$HOME/paseo node --input-type=module - < package-runtime.mjs
// Output dir: --out, else PASEO_ARTIFACT_DIR, else ~/.paseo/artifacts. Staging
// happens inside the output dir, so point it at a disk with ~2 GiB free.
// Prints the tarball path on stdout (everything else goes to stderr).
//
// Tarball: paseo-runtime-<version>-<commit>[-dirty]-<platform>-node<major>.tar.gz, one
// top-level directory of the same name:
//   bin/node        the node binary running this script (native modules in the
//                   tree were built against it, so the ABI always matches)
//   bin/paseo       CLI wrapper (resolves its own location, no nvm)
//   lib/            repo-shaped subset: the workspace packages the CLI needs
//                   plus exactly the installed node_modules they resolve to
//   lib/deploy/     host-side helpers: deploy-nudge.mjs, the canonical system
//                   prompt (scripts/paseo-system-prompt.md) and its patcher
//                   (scripts/set-append-system-prompt.mjs); targets have no
//                   checkout, so activation applies the prompt from here
//   release.json    version, commit, platform, node, builder, build time
//
// Why not `pnpm deploy`: it re-resolves dependencies (shared-lockfile deploy
// falls back to resolution in this workspace), drops the patch-package patches
// applied by scripts/postinstall-patches.mjs, and skips the patched
// @parcel/watcher native rebuild. Copying the builder's installed tree keeps
// every byte the builder's own daemon runs, patches and native builds included.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.PASEO_REPO_DIR
  ? path.resolve(process.env.PASEO_REPO_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY_PACKAGE = path.join(REPO, "packages", "cli");

// Same exclusions the desktop app applies to workspace packages (see
// packages/desktop/electron-builder.yml) minus web-ui/builtin-plugins, which
// the standalone daemon serves/loads from its own package.
const WORKSPACE_SKIP = new Set([
  "node_modules",
  "src",
  ".debug",
  ".tasks",
  "conversations",
  "test-results",
  "coverage",
  "e2e",
]);
const SKIP_FILE = /(\.map|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|\.tsbuildinfo)$/;

function log(message) {
  process.stderr.write(`[package-runtime] ${message}\n`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function platformTag() {
  const arch = { x64: "x64", arm64: "arm64" }[process.arch] ?? process.arch;
  return `${process.platform}-${arch}`;
}

function git(args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
}

function inRepo(file) {
  const rel = path.relative(REPO, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`resolved outside the checkout: ${file}`);
  }
  return rel;
}

// Node's lookup for a bare specifier from a package directory: walk up the
// directory chain checking <dir>/node_modules/<name>. Returns the path where it
// was found (often a pnpm symlink) — that link must exist in the artifact too.
function lookup(fromDir, name) {
  let dir = fromDir;
  while (true) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectClosure() {
  const packages = new Map(); // realDir -> { workspace }
  const links = new Map(); // link path (in repo) -> link target text
  const missingRequired = [];
  const queue = [{ lookupPath: ENTRY_PACKAGE }];
  while (queue.length > 0) {
    const { lookupPath } = queue.shift();
    const realDir = realpathSync(lookupPath);
    // Record every symlink hop between the lookup path and the real dir.
    let hop = lookupPath;
    for (let depth = 0; depth < 8 && lstatSync(hop).isSymbolicLink(); depth += 1) {
      const target = readlinkSync(hop);
      const resolved = path.resolve(path.dirname(hop), target);
      links.set(inRepo(hop), path.relative(path.dirname(hop), resolved));
      hop = resolved;
    }
    if (packages.has(realDir)) continue;
    inRepo(realDir);
    const workspace = !realDir.includes(`${path.sep}node_modules${path.sep}`);
    packages.set(realDir, { workspace });
    const pkg = readJson(path.join(realDir, "package.json"));
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    const peerOptional = new Set(
      Object.entries(pkg.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta?.optional)
        .map(([name]) => name),
    );
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...optional,
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const found = lookup(realDir, name);
      if (found) {
        queue.push({ lookupPath: found });
      } else if (!optional.has(name) && !peerOptional.has(name) && !pkg.peerDependencies?.[name]) {
        missingRequired.push(`${pkg.name} -> ${name}`);
      }
    }
  }
  if (missingRequired.length > 0) {
    throw new Error(`unresolved required dependencies:\n  ${missingRequired.join("\n  ")}`);
  }
  return { packages, links };
}

function copyPackage(realDir, workspace, libDir) {
  const dest = path.join(libDir, inRepo(realDir));
  cpSync(realDir, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(realDir, src);
      if (rel === "") return true;
      const top = rel.split(path.sep)[0];
      // Nested node_modules are dependency links; the closure walk adds the
      // ones that are actually needed.
      if (top === "node_modules") return false;
      if (workspace) {
        if (WORKSPACE_SKIP.has(top)) return false;
        if (/^(tsconfig|vitest|vite|eslint|knip)[^/]*$/.test(rel)) return false;
        if (SKIP_FILE.test(rel)) return false;
      }
      return true;
    },
  });
}

function writeWrapper(binDir) {
  const wrapper = path.join(binDir, "paseo");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
# Paseo CLI from a packaged runtime. Resolves its own release directory through
# any symlink chain (~/.local/bin/paseo -> current -> releases/<id>).
set -euo pipefail
self="\${BASH_SOURCE[0]}"
while [[ -L "$self" ]]; do
  link="$(readlink "$self")"
  [[ "$link" == /* ]] || link="$(dirname "$self")/$link"
  self="$link"
done
release="$(cd -P "$(dirname "$self")/.." && pwd)"
exec "$release/bin/node" --disable-warning=DEP0040 "$release/lib/packages/cli/dist/index.js" "$@"
`,
  );
  chmodSync(wrapper, 0o755);
}

function resolveOutDir() {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1) return path.resolve(process.argv[outIndex + 1]);
  if (process.env.PASEO_ARTIFACT_DIR) return path.resolve(process.env.PASEO_ARTIFACT_DIR);
  return path.join(homedir(), ".paseo", "artifacts");
}

function main() {
  const outDir = resolveOutDir();

  for (const required of [
    "packages/cli/dist/index.js",
    "packages/server/dist/scripts/supervisor-entrypoint.js",
    "packages/server/dist/server/web-ui/index.html",
  ]) {
    if (!existsSync(path.join(REPO, required))) {
      throw new Error(`missing ${required}: run build:server and build:daemon-web-ui first`);
    }
  }

  const version = readJson(path.join(ENTRY_PACKAGE, "package.json")).version;
  const commit = git(["rev-parse", "--short=9", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
  const platform = platformTag();
  const nodeMajor = process.versions.node.split(".")[0];
  const release = `paseo-runtime-${version}-${commit}${dirty ? "-dirty" : ""}-${platform}-node${nodeMajor}`;

  // A clean commit packaged with the same node major is the same runtime:
  // reuse it so redeploys ship a byte-identical file (targets skip the copy).
  const existing = path.join(outDir, `${release}.tar.gz`);
  if (!dirty && existsSync(existing)) {
    log(`${existing} already packaged for this commit; reusing`);
    process.stdout.write(`${existing}\n`);
    return;
  }

  const stage = path.join(outDir, `.stage-${process.pid}`);
  const root = path.join(stage, release);
  const libDir = path.join(root, "lib");
  const binDir = path.join(root, "bin");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });

  const { packages, links } = collectClosure();
  log(`closure: ${packages.size} packages, ${links.size} links`);
  for (const [realDir, { workspace }] of packages) copyPackage(realDir, workspace, libDir);
  for (const [linkPath, target] of links) {
    const dest = path.join(libDir, linkPath);
    if (existsSync(dest) || isLink(dest)) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(target, dest);
  }
  // Host-side helpers resolve @getpaseo/client and ws through the CLI's deps.
  mkdirSync(path.join(libDir, "packages", "cli", "deploy"), { recursive: true });
  for (const file of [
    "deploy-nudge.mjs",
    "paseo-system-prompt.md",
    "set-append-system-prompt.mjs",
    "set-web-ui-config.mjs",
  ]) {
    copyFileSync(
      path.join(REPO, "scripts", file),
      path.join(libDir, "packages", "cli", "deploy", file),
    );
  }
  // Stable path for activate-runtime.sh: lib/deploy -> packages/cli/deploy.
  symlinkSync(path.join("packages", "cli", "deploy"), path.join(libDir, "deploy"));

  copyFileSync(process.execPath, path.join(binDir, "node"));
  chmodSync(path.join(binDir, "node"), 0o755);
  writeWrapper(binDir);
  writeFileSync(
    path.join(root, "release.json"),
    `${JSON.stringify(
      {
        release,
        version,
        commit,
        dirty,
        platform,
        node: process.version,
        builder: hostname(),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  mkdirSync(outDir, { recursive: true });
  const tarball = path.join(outDir, `${release}.tar.gz`);
  const partial = `${tarball}.partial`;
  execFileSync("tar", ["-czf", partial, "-C", stage, release], { stdio: "inherit" });
  execFileSync("mv", [partial, tarball]);
  // One tarball per builder: older ones are never shipped again.
  for (const file of readdirSync(outDir)) {
    if (/^paseo-runtime-.*\.tar\.gz(\.partial)?$/.test(file) && file !== path.basename(tarball)) {
      rmSync(path.join(outDir, file), { force: true });
      log(`removed old ${file}`);
    }
  }
  rmSync(stage, { recursive: true, force: true });
  log(`${tarball} (${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MiB)`);
  process.stdout.write(`${tarball}\n`);
}

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

try {
  main();
} catch (error) {
  log(`error: ${error.message}`);
  process.exit(1);
}
