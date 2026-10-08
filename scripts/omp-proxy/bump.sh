#!/usr/bin/env bash
# Pin omp-proxy to an omp release: set the three @oh-my-pi packages to
# <version>, reinstall, typecheck and build. Commit the result, then deploy;
# deploy refuses to touch prod while this pin differs from the fleet's omp.
#
#   scripts/omp-proxy/bump.sh 18.8.3
set -euo pipefail

version="${1:?usage: bump.sh <omp version, e.g. 18.8.3>}"
version="${version#v}"
version="${version#omp/}"
cd "$(dirname "$0")"

for pkg in pi-ai pi-catalog pi-coding-agent; do
  if ! npm view "@oh-my-pi/$pkg@$version" version >/dev/null 2>&1; then
    echo "bump: @oh-my-pi/$pkg@$version is not on npm" >&2
    exit 1
  fi
done

bun - "$version" <<'EOF'
const version = process.argv[2];
const file = Bun.file("package.json");
const pkg = await file.json();
for (const name of ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-coding-agent"]) {
  pkg.dependencies[name] = version;
}
await Bun.write(file, `${JSON.stringify(pkg, null, "\t")}\n`);
EOF

bun install
bun run typecheck
bun run build
echo "bump: omp-proxy pinned to $version; dist/omp-proxy built. Commit package.json and bun.lock."
