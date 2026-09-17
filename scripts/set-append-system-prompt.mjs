#!/usr/bin/env node
// Sets daemon.appendSystemPrompt in a Paseo config.json, leaving every other
// key untouched. Runs locally or piped over ssh (`ssh host "node - <b64>" < this`),
// so the prompt text arrives base64-encoded to survive argv and shell quoting.
//
// Usage: node set-append-system-prompt.mjs <base64-prompt> [configPath]
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const [, , encoded, explicitPath] = process.argv;
if (!encoded) {
  console.error("missing base64 prompt argument");
  process.exit(2);
}

const prompt = Buffer.from(encoded, "base64").toString("utf8").trim();
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

config.daemon ??= {};
const before = config.daemon.appendSystemPrompt ?? "";
if (before === prompt) {
  console.log(`unchanged ${configPath}`);
  process.exit(0);
}
config.daemon.appendSystemPrompt = prompt;

// Write through a temp file in the same directory so a crash can't truncate a
// live config the daemon may read at boot.
mkdirSync(path.dirname(configPath), { recursive: true });
const tmp = `${configPath}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(tmp, configPath);

console.log(`${existed ? "updated" : "created"} ${configPath} (${prompt.length} chars)`);
