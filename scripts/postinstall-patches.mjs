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
  // Backport for expo-modules-core 57.0.23: https://github.com/expo/expo/pull/49634.
  // Remove when the installed Expo SDK includes the Activity recreation fix.
  {
    nodeModulesPath: "packages/app/node_modules/expo-modules-core",
    patchPrefix: "expo-modules-core+",
    cwd: "packages/app",
  },
  // Backport https://github.com/software-mansion/enriched-markdown/pull/924: preserve settled
  // Android measurements across parent clones. Remove those hunks when upgrading past
  // 1.2.0-nightly-20261019-926ef06f0; reconcile the other local patch hunks separately.
  {
    nodeModulesPath: "packages/app/node_modules/react-native-enriched-markdown",
    patchPrefix: "react-native-enriched-markdown+",
    cwd: "packages/app",
  },
  // Registry cleanup: remove after react-native-unistyles ships
  // https://github.com/jpudysz/react-native-unistyles/pull/1203.
  // withUnistyles: also keep the uniProps filter until upstream consumes its control prop.
  {
    nodeModulesPath: "packages/app/node_modules/react-native-unistyles",
    patchPrefix: "react-native-unistyles+",
    cwd: "packages/app",
  },
  // Backport of https://github.com/software-mansion/react-native-reanimated/pull/10435
  // (Reanimated 4.7.1): skip synchronous Android prop updates for unmounted view tags
  // instead of throwing and printing a full stack trace on the UI thread per tag per event.
  // Remove when the installed Reanimated is >= 4.7.1.
  {
    nodeModulesPath: "packages/app/node_modules/react-native-reanimated",
    patchPrefix: "react-native-reanimated+",
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
  // @xterm/addon-ligatures ships lru-cache inlined in its prebuilt .mjs,
  // which imports node:diagnostics_channel at module top level — absent in
  // every shipped JS runtime (2026-09-09 bundle outage). Dummy the import.
  {
    nodeModulesPath: "packages/app/node_modules/@xterm/addon-ligatures",
    patchPrefix: "@xterm+addon-ligatures+",
    cwd: "packages/app",
  },
  // Exports BottomSheetModalInternalProvider so a subtree can host its own sheets on the shared
  // modal stack (see packages/app/src/components/ui/isolated-bottom-sheet-modal/host-scope.tsx), and
  // keeps a dismissing modal's status through its final onChange(-1), so a modal with
  // enableDismissOnClose=false that unmounts while presented still leaves the portal.
  // Dimensions subscription cleanup: https://github.com/gorhom/react-native-bottom-sheet/issues/2734
  // and https://github.com/gorhom/react-native-bottom-sheet/pull/2751. Remove the useAnimatedLayout
  // hunks once an installed release includes the cleanup; retain the other local hunks.
  {
    nodeModulesPath: "packages/app/node_modules/@gorhom/bottom-sheet",
    patchPrefix: "@gorhom+bottom-sheet+",
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

const isWindows = process.platform === "win32";
const cmd = isWindows ? "patch-package.cmd" : "patch-package";

let failed = false;
for (const [index, { nodeModulesPath, patchPrefix, cwd = "." }] of installedPackages.entries()) {
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const outcome = applyPatches(cwd, files, index);
  if (outcome === "applied") {
    continue;
  }
  failed = true;
  if (outcome === "unavailable") {
    continue;
  }
  // patch-package cannot apply a patch that changed after an earlier version of it was
  // applied. Without the package, the next install fetches it clean and applies the patch.
  rmSync(nodeModulesPath, { recursive: true, force: true });
  console.error(
    `postinstall-patches: removed ${nodeModulesPath} because its patch did not apply. ` +
      "Run pnpm install again to reinstall it with the current patch. " +
      "If it fails again on the clean package, the patch is out of date and must be regenerated.",
  );
}

// @parcel/watcher ships native code as prebuilt platform packages; patching the
// source alone does not change what the daemon loads. Rebuild the binding from
// the patched source (index.js prefers ./build/Release/watcher.node) so the
// inotify EINTR retry is actually live. Requires a C++ toolchain (node-gyp);
// the repo already requires one for its React Native native deps.
const needsNativeRebuild = !failed && installedPackages.some(({ rebuildNative }) => rebuildNative);
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

process.exit(failed ? 1 : 0);

function applyPatches(cwd, files, index) {
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${index}`);
  mkdirSync(tempPatchDir, { recursive: true });
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  let result;
  try {
    result = spawnSync(cmd, ["--patch-dir", relative(cwd, tempPatchDir), "--error-on-fail"], {
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
    return "unavailable";
  }
  return result.status === 0 ? "applied" : "rejected";
}
