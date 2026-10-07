// Copies the two OMP plugins that omp-proxy compiles in (from the repo's
// plugins/ directory) into vendor/. `bun run build` runs it first.
// The copies get `@ts-nocheck`: OMP loads plugins without a type check, and
// their own type declarations do not match the pinned OMP packages exactly.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PLUGINS = ["omp-grok-build", "omp-account-routing"];
const sourceRoot = path.resolve(import.meta.dir, "..", "..", "..", "plugins");
const vendorRoot = path.resolve(import.meta.dir, "..", "vendor");

rmSync(vendorRoot, { recursive: true, force: true });
for (const name of PLUGINS) {
	const source = path.join(sourceRoot, name);
	const target = path.join(vendorRoot, name);
	mkdirSync(target, { recursive: true });
	cpSync(path.join(source, "package.json"), path.join(target, "package.json"));
	for (const file of readdirSync(path.join(source, "src"))) {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
		const text = readFileSync(path.join(source, "src", file), "utf8");
		writeFileSync(path.join(target, file), `// @ts-nocheck -- vendored copy of ${name}; see scripts/sync-plugins.ts\n${text}`);
	}
	console.log(`vendored ${name}`);
}
