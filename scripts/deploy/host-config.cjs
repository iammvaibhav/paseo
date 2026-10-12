// Patches a host's Paseo config.json with the fleet-managed keys and leaves
// every other key alone. deploy.sh pipes this file to `node -` over ssh with
// one line prepended that defines the payload, so secrets travel over ssh
// stdin only (never argv, never logs):
//
//   globalThis.PASEO_HOST_CONFIG = { ... };
//
// Payload (every field optional):
//   home                 Paseo home (default ~/.paseo)
//   peers                full peers array; replaces the existing one
//   hostnames            merged into daemon.hostnames (never removes entries)
//   initListen           daemon.listen, only when unset
//   initPasswordHash     daemon.auth.password (bcrypt), only when unset
//
// daemon.appendSystemPrompt is NOT handled here: its source of truth is the
// repo's scripts/paseo-system-prompt.md (set-append-system-prompt.mjs).
//
// Prints one line per changed key, never a value.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const payload = globalThis.PASEO_HOST_CONFIG;
if (!payload || typeof payload !== "object") {
  console.error("host-config: missing globalThis.PASEO_HOST_CONFIG payload");
  process.exit(2);
}

const home = (payload.home || "~/.paseo").replace(/^~(?=$|\/)/, os.homedir());
const configPath = path.join(home, "config.json");

let config = {};
let existed = false;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  existed = true;
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(`host-config: refusing to touch unparseable ${configPath}: ${error.message}`);
    process.exit(1);
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changed = [];
config.daemon ??= {};

if (Array.isArray(payload.peers) && !same(config.peers ?? [], payload.peers)) {
  const names = payload.peers.map((peer) => peer.name).join(", ");
  config.peers = payload.peers;
  changed.push(`peers (${payload.peers.length}: ${names})`);
}

if (Array.isArray(payload.hostnames)) {
  const current = Array.isArray(config.daemon.hostnames) ? config.daemon.hostnames : [];
  const missing = payload.hostnames.filter((name) => name && !current.includes(name));
  if (missing.length > 0) {
    config.daemon.hostnames = [...current, ...missing];
    changed.push(`daemon.hostnames (+${missing.join(", ")})`);
  }
}

if (typeof payload.initListen === "string" && !config.daemon.listen) {
  config.daemon.listen = payload.initListen;
  changed.push(`daemon.listen (${payload.initListen})`);
}

if (typeof payload.initPasswordHash === "string" && !config.daemon.auth?.password) {
  config.daemon.auth = { ...config.daemon.auth, password: payload.initPasswordHash };
  changed.push("daemon.auth.password (initialized)");
}

if (changed.length === 0) {
  console.log(`unchanged ${configPath}`);
  process.exit(0);
}

// Same directory temp file + rename: a crash never truncates a config the
// daemon may read at boot.
fs.mkdirSync(home, { recursive: true });
const tmp = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, configPath);
console.log(`${existed ? "updated" : "created"} ${configPath}: ${changed.join("; ")}`);
