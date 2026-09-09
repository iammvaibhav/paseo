import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Under pnpm's isolated node_modules layout,
// a package is only reachable inside the node_modules of whichever workspace member(s)
// declare it directly — nothing gets hoisted to the repo root the way npm's flat
// node_modules did. patch-package resolves the patch's node_modules/... paths relative
// to its working directory, so nodeModulesPath/cwd must point at the declaring workspace,
// not the repo root. When a package is shared by several workspace members (e.g.
// react-native, declared by app/plugin/expo-two-way-audio), pnpm links every consumer's
// copy to the same underlying store directory, so patching through any one consumer's
// path patches the shared target for all of them.
const patchedPackages = [
  {
    nodeModulesPath: "packages/app/node_modules/react-native-markdown-display",
    patchPrefix: "react-native-markdown-display+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "packages/app/node_modules/react-native",
    patchPrefix: "react-native+",
    cwd: "packages/app",
  },
  // Remove after react-native-unistyles ships
  // https://github.com/jpudysz/react-native-unistyles/pull/1203.
  {
    nodeModulesPath: "packages/app/node_modules/react-native-unistyles",
    patchPrefix: "react-native-unistyles+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "packages/app/node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "packages/app/node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "packages/app/node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "packages/app/node_modules/@mattermost/react-native-paste-input",
    patchPrefix: "@mattermost+react-native-paste-input+",
    cwd: "packages/app",
  },
  {
    nodeModulesPath: "packages/server/node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: "packages/server",
  },
  {
    nodeModulesPath: "node_modules/@parcel/watcher",
    patchPrefix: "@parcel+watcher+",
    rebuildNative: true,
  },
];

const installedPackages = patchedPackages.filter(({ nodeModulesPath }) =>
  existsSync(nodeModulesPath),
);

if (!existsSync("patches") || installedPackages.length === 0) {
  process.exit(0);
}

const patchFiles = readdirSync("patches").filter((file) => file.endsWith(".patch"));

// Group patch files by the directory patch-package must run from.
const patchFilesByCwd = new Map();
for (const { patchPrefix, cwd = "." } of installedPackages) {
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const group = patchFilesByCwd.get(cwd) ?? [];
  group.push(...files);
  patchFilesByCwd.set(cwd, group);
}

if (patchFilesByCwd.size === 0) {
  process.exit(0);
}

const isWindows = process.platform === "win32";
const cmd = isWindows ? "patch-package.cmd" : "patch-package";

let groupIndex = 0;
for (const [cwd, files] of patchFilesByCwd) {
  groupIndex += 1;
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${groupIndex}`);

  mkdirSync(tempPatchDir, { recursive: true });
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  let result;
  try {
    result = spawnSync(cmd, ["--patch-dir", relative(cwd, tempPatchDir)], {
      cwd,
      shell: isWindows,
      stdio: "inherit",
      windowsHide: true,
    });
  } finally {
    rmSync(tempPatchDir, { recursive: true, force: true });
  }

  if (result.error) {
    console.error("postinstall-patches: patch-package failed to spawn:", result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// @parcel/watcher ships native code as prebuilt platform packages; patching the
// source alone does not change what the daemon loads. Rebuild the binding from
// the patched source (index.js prefers ./build/Release/watcher.node) so the
// inotify EINTR retry is actually live. Requires a C++ toolchain (node-gyp);
// the repo already requires one for its React Native native deps.
const needsNativeRebuild = installedPackages.some(({ rebuildNative }) => rebuildNative);
if (needsNativeRebuild) {
  const nodeGyp = resolve("node_modules", "node-gyp", "bin", "node-gyp.js");
  const watcherDir = "node_modules/@parcel/watcher";
  if (!existsSync(nodeGyp)) {
    console.error("postinstall-patches: node-gyp not found; cannot rebuild @parcel/watcher");
    process.exit(1);
  }
  const rebuild = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
    cwd: watcherDir,
    stdio: "inherit",
  });
  if (rebuild.status !== 0) {
    console.error("postinstall-patches: failed to rebuild @parcel/watcher");
    process.exit(rebuild.status ?? 1);
  }
  console.log("postinstall-patches: rebuilt @parcel/watcher from patched source");
}

process.exit(0);
