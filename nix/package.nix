{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm,
  nodejs_22,
  python3,
  makeWrapper,
  autoPatchelfHook,
  # node-pty needs libuv headers on Linux
  libuv,
  # Exposed so downstream flakes that follow a different nixpkgs revision
  # (where `fetchPnpmDeps` may produce a different hash for the same
  # lockfile) can override via `.override { pnpmDepsHash = "sha256-..."; }`
  # without `overrideAttrs` gymnastics — `pnpmDepsHash` is consumed directly
  # by the `fetchPnpmDeps` call below, so `overrideAttrs` cannot reach it.
  #
  # The default is read from a sidecar file so the CI auto-updater can replace
  # the hash with a single file write instead of a sed against this source.
  pnpmDepsHash ? lib.fileContents ./pnpm-deps.hash,
}:

stdenv.mkDerivation rec {

  pname = "paseo";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let
        baseName = builtins.baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Exclude non-daemon workspace contents (keep package.json for workspace resolution)
      !(lib.hasPrefix "/packages/app/android" relPath)
      && !(lib.hasPrefix "/packages/app/ios" relPath)
      && !(lib.hasPrefix "/packages/website/src" relPath)
      && !(lib.hasPrefix "/packages/website/public" relPath)
      && !(lib.hasPrefix "/packages/desktop/src" relPath)
      && !(lib.hasPrefix "/packages/desktop/src-tauri" relPath)
      # Documentation, CI definitions and agent/editor configuration. None of
      # these reach the build. Excluding them here also matters for the desktop
      # derivation, which inherits this package's pnpmDeps: leaving them in
      # makes a docs-only commit produce a new pnpm-deps .drv, and so a new
      # desktop .drv, and so a full rebuild for a byte-identical result.
      && !(lib.hasPrefix "/docs" relPath)
      && !(lib.hasPrefix "/.github" relPath)
      && !(lib.hasPrefix "/.agents" relPath)
      && !(lib.hasPrefix "/.claude" relPath)
      && !(lib.hasPrefix "/.codex" relPath)
      && !(lib.hasPrefix "/docker" relPath)
      # Top-level prose only (README, CHANGELOG, AGENTS...). Deeper markdown is
      # not necessarily documentation: skills/*/SKILL.md is a runtime file the
      # daemon's trace script copies into the output.
      && builtins.match "/[^/]+\\.md" relPath == null
      # Exclude test fixtures and debug files
      && !(lib.hasSuffix ".test.ts" baseName)
      && !(lib.hasSuffix ".e2e.test.ts" baseName)
      && baseName != "node_modules"
      && baseName != ".git"
      && baseName != ".paseo"
      && baseName != ".DS_Store";
  };

  # Default hash lives in nix/pnpm-deps.hash (see arg default above).
  # CI auto-updates that file when pnpm-lock.yaml changes (see .github/workflows/).
  pnpmDeps = fetchPnpmDeps {
    inherit pname version src;
    # Bump only alongside a hash refresh — see the fetcherVersion history at
    # https://nixos.org/manual/nixpkgs/unstable/#javascript-pnpm-fetcherVersion.
    fetcherVersion = 3;
    hash = pnpmDepsHash;
  };

  # Unlike `buildNpmPackage`'s automatic npm rebuild, `pnpmConfigHook`'s
  # `pnpm install` always passes `--ignore-scripts` unconditionally (see
  # nixpkgs' pnpm-config-hook.sh), so onnxruntime-node's install script
  # (which tries to download from api.nuget.org and fails in the sandbox)
  # never runs automatically — no equivalent of `npmRebuildFlags` is needed.
  # We still manually rebuild node-pty in buildPhase, same as before.

  nativeBuildInputs = [
    nodejs_22
    pnpm
    pnpmConfigHook
    python3 # for node-gyp (node-pty compilation)
    makeWrapper
  ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    libuv
    stdenv.cc.cc.lib # libstdc++ for sherpa-onnx prebuilt binaries
  ];

  buildPhase = ''
    runHook preBuild

    # Rebuild only node-pty (native addon for terminal emulation). The sherpa
    # speech runtime ships prebuilt platform packages and is copied into the
    # daemon closure by scripts/trace-daemon.mjs.
    pnpm rebuild node-pty

    # Build all server packages in dependency order (defined in package.json)
    pnpm run build:server
    pnpm run build:daemon-web-ui

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Compute the daemon's runtime closure by static module-graph tracing
    # (@vercel/nft from supervisor-entrypoint.js, cli/dist/index.js, and the
    # forked terminal/speech worker processes) plus an explicit list of non-JS
    # assets read at runtime. The trace script is the single source of
    # truth for what the daemon needs at $out — auditable in plain JS, no
    # npm hoisting / .bin / workspace-symlink footguns.
    mkdir -p $out/lib/paseo
    node scripts/trace-daemon.mjs > daemon-files.txt

    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$out/lib/paseo/$(dirname "$path")"
      cp -a "$path" "$out/lib/paseo/$path"
    done < daemon-files.txt

    # Root package.json lets node resolve the workspace layout when the
    # CLI/server bin starts from $out.
    cp package.json $out/lib/paseo/

    # Web UI Assets
    cp -r packages/server/dist/server/web-ui $out/lib/paseo/packages/server/dist/server/

    # Create wrapper for the server entry point (for systemd / direct use)
    mkdir -p $out/bin
    # Keep Paseo's runtime mode separate from NODE_ENV, which belongs to spawned agents.
    makeWrapper ${nodejs_22}/bin/node $out/bin/paseo-server \
      --add-flags "$out/lib/paseo/packages/server/dist/scripts/supervisor-entrypoint.js" \
      --set PASEO_NODE_ENV production

    # Create wrapper for the CLI
    makeWrapper ${nodejs_22}/bin/node $out/bin/paseo \
      --add-flags "$out/lib/paseo/packages/cli/dist/index.js" \
      --set NODE_PATH "$out/lib/paseo/node_modules"

    runHook postInstall
  '';

  meta = {
    description = "Self-hosted daemon for Claude Code, Codex, and OpenCode";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.agpl3Plus;
    mainProgram = "paseo";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
