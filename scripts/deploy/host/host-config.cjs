// Patches a host's Paseo config.json with the fleet-managed keys and leaves
// every other key alone. scripts/deploy/main.ts runs it on the host with the
// payload in env PASEO_HOST_CONFIG (JSON), so secrets never reach argv or logs.
//
// Payload (every field optional):
//   peers                full peers array; replaces the existing one
//   hostnames            merged into daemon.hostnames (never removes entries)
//   appendSystemPrompt   daemon.appendSystemPrompt (from the repo's
//                        scripts/paseo-system-prompt.md; never copied from a host)
//   webUi                features.webUi.enabled
//   localSpeechDefault   false: dictation and voice mode stay off unless this
//                        host's config already turned them on, so the daemon
//                        never downloads its local speech models (~765 MiB)
//   listen               daemon.listen (targets: always their inventory address,
//                        so a moved host binds its new IP on activation)
//   initPassword         daemon password, stored bcrypt-hashed in
//                        daemon.auth.password, only when unset
//
// Prints one line per changed key, never a value.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const payload = JSON.parse(process.env.PASEO_HOST_CONFIG ?? "null");
if (!payload || typeof payload !== "object") {
  console.error("host-config: missing PASEO_HOST_CONFIG payload");
  process.exit(2);
}

const home = path.join(os.homedir(), ".paseo");
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

if (typeof payload.appendSystemPrompt === "string") {
  const prompt = payload.appendSystemPrompt.trim();
  if ((config.daemon.appendSystemPrompt ?? "") !== prompt) {
    config.daemon.appendSystemPrompt = prompt;
    changed.push(`daemon.appendSystemPrompt (${prompt.length} chars)`);
  }
}

if (typeof payload.webUi === "boolean" && config.features?.webUi?.enabled !== payload.webUi) {
  config.features = {
    ...config.features,
    webUi: { ...config.features?.webUi, enabled: payload.webUi },
  };
  changed.push(`features.webUi.enabled (${payload.webUi})`);
}

// The daemon enables dictation and voice mode when the keys are unset, and then
// downloads ~765 MiB of local speech models. Voice is opt-in for this fleet:
// only an explicit `enabled: true` someone set on the host keeps it.
if (payload.localSpeechDefault === false) {
  config.features ??= {};
  for (const key of ["dictation", "voiceMode"]) {
    if (config.features[key]?.enabled === undefined) {
      config.features[key] = { ...config.features[key], enabled: false };
      changed.push(`features.${key}.enabled (false)`);
    }
  }
}

if (typeof payload.listen === "string" && config.daemon.listen !== payload.listen) {
  config.daemon.listen = payload.listen;
  changed.push(`daemon.listen (${payload.listen})`);
}

if (typeof payload.initPassword === "string" && !config.daemon.auth?.password) {
  // Hash with the runtime's own bcryptjs, at the daemon's cost (12, see
  // DAEMON_PASSWORD_BCRYPT_COST in packages/server/src/server/auth.ts).
  const runtime = path.join(
    os.homedir(),
    ".local/share/paseo/current/lib/packages/server/package.json",
  );
  const { hashSync } = require("node:module").createRequire(runtime)("bcryptjs");
  config.daemon.auth = { ...config.daemon.auth, password: hashSync(payload.initPassword, 12) };
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
