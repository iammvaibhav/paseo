#!/usr/bin/env node
// Sets features.webUi.enabled in a Paseo config.json, leaving every other key
// untouched. Runs locally or piped over ssh (`ssh host "node - true" < this`).
//
// Why the persisted setting and not just the CLI flag: `daemon restart --web-ui`
// only reaches the worker when the CLI actually forwards it, and on a remote
// host it does not — blrofc3 restarted with the flag and its daemon environment
// had no PASEO_WEB_UI_ENABLED, so GET / stayed 404 with the bundle already on
// disk. The persisted value is what survives every start path.
//
// Usage: node set-web-ui-config.mjs [true|false] [configPath]
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const [, , enabledArg, explicitPath] = process.argv;
const enabled = enabledArg !== "false" && enabledArg !== "0";
const configPath = explicitPath || path.join(homedir(), ".paseo", "config.json");

let config = {};
let existed = false;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
  existed = true;
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(`refusing to overwrite unparseable config at ${configPath}: ${error.message}`);
    process.exit(1);
  }
}

config.features ??= {};
config.features.webUi ??= {};
if (config.features.webUi.enabled === enabled) {
  console.log(`unchanged ${configPath} (features.webUi.enabled = ${enabled})`);
  process.exit(0);
}
config.features.webUi.enabled = enabled;

// Write through a temp file in the same directory so a crash cannot truncate a
// live config the daemon may read at boot.
mkdirSync(path.dirname(configPath), { recursive: true });
const tmp = `${configPath}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(tmp, configPath);

console.log(`${existed ? "updated" : "created"} ${configPath} (features.webUi.enabled = ${enabled})`);
