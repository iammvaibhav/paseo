// Builds dist/omp-proxy with OMP's native addon inside it, the way omp's own
// release binary carries it. Since omp 19.2 the omp binary unpacks its addon
// to ~/.omp/natives/<version>/embedded-<hash>/, a path a binary without its
// own copy never looks in, so the proxy ships the addon and unpacks it the
// same way. `bun run build` runs scripts/sync-plugins.ts first.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PLATFORM = "linux-arm64";
const FILENAME = `pi_natives.${PLATFORM}.node`;

const root = path.resolve(import.meta.dir, "..");
const nativesPackage = (name: string): string =>
	path.dirname(Bun.resolveSync(`${name}/package.json`, root));
const { version } = JSON.parse(
	readFileSync(path.join(nativesPackage("@oh-my-pi/pi-natives"), "package.json"), "utf8"),
) as { version: string };
const addon = readFileSync(path.join(nativesPackage(`@oh-my-pi/pi-natives-${PLATFORM}`), FILENAME));

// pi-natives extracts the frame to embedded-<hash>/ and checks only its size.
const buildDir = path.join(root, "dist", "natives");
mkdirSync(buildDir, { recursive: true });
const zstdPath = path.join(buildDir, `${FILENAME}.zst`);
writeFileSync(zstdPath, Bun.zstdCompressSync(addon));
const manifest = {
	platformTag: PLATFORM,
	version,
	files: [
		{
			variant: "default",
			filename: FILENAME,
			size: addon.length,
			hash: Bun.hash.xxHash64(addon).toString(16),
		},
	],
};

const embedNative: Bun.BunPlugin = {
	name: "embed-pi-natives",
	setup(build) {
		build.onLoad({ filter: /pi-natives[\\/]native[\\/]embedded-addon\.js$/ }, () => ({
			loader: "js",
			contents: [
				`import zstdPath from ${JSON.stringify(zstdPath)} with { type: "file" };`,
				`const manifest = ${JSON.stringify(manifest)};`,
				"export const embeddedAddon = { ...manifest, files: manifest.files.map(file => ({ ...file, zstdPath })) };",
			].join("\n"),
		}));
	},
};

const result = await Bun.build({
	entrypoints: [path.join(root, "src", "main.ts")],
	compile: { target: "bun-linux-arm64", outfile: path.join(root, "dist", "omp-proxy") },
	minify: true,
	// OMP generates this module so that plugins on disk can import OMP; the
	// proxy compiles its plugins in (README "Build").
	external: ["omp-legacy-pi-modules"],
	plugins: [embedNative],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`built dist/omp-proxy with pi_natives ${version} (${addon.length} bytes) embedded`);
