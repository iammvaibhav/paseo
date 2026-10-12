#!/usr/bin/env node
// Fleet inventory for scripts/deploy.sh.
//
// The inventory is a host-local JSON file (never committed; default
// ~/.paseo/fleet-hosts.json, override with PASEO_FLEET_INVENTORY). Every entry
// is one machine that runs a Paseo daemon. Adding a machine to the fleet is one
// new entry plus a deploy run. Format: scripts/deploy/fleet-hosts.example.json.
//
// Builders check out the repo and build. Targets receive the packaged runtime
// built by their `buildFrom` builder (same platform) and never build.
//
// Usage: node scripts/deploy/fleet.mjs <command> [args]
//   validate                      parse + check the inventory, print a summary
//   list [--role R] [--daemon D]  host names, one per line
//   field <host> <key>            one field (defaults applied), empty if unset
//   self                          entry whose address is bound on this machine
//   targets <builder>             targets that receive <builder>'s runtime
//   peers <host>                  JSON peers array for <host>: every other host
//   password-var <host>           env var holding <host>'s daemon password
//
// Peer passwords come from env vars PASEO_HOST_PASSWORD_<HOST> (host name
// upper-cased, non-alphanumerics as "_"), loaded by deploy.sh from
// ~/.paseo/deploy.env. This script never prints a password except inside the
// `peers` JSON, which deploy.sh pipes straight to the host over ssh stdin.
import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";

const PLATFORMS = new Set(["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"]);
const ROLES = new Set(["builder", "target"]);
const DAEMON_MODES = new Set(["systemd", "desktop"]);
const DEFAULT_PORT = 6767;

export function inventoryPath(env = process.env) {
  return env.PASEO_FLEET_INVENTORY || path.join(homedir(), ".paseo", "fleet-hosts.json");
}

export function passwordVar(name) {
  return `PASEO_HOST_PASSWORD_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function fail(message) {
  throw new Error(`fleet inventory: ${message}`);
}

export function parseInventory(raw, source = "inventory") {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`${source} is not valid JSON: ${error.message}`);
  }
  if (!data || !Array.isArray(data.hosts) || data.hosts.length === 0) {
    fail(`${source} must contain a non-empty "hosts" array`);
  }
  const hosts = data.hosts.map((entry, index) => {
    const where = `hosts[${index}]`;
    for (const key of ["name", "ssh", "address", "platform", "role"]) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        fail(`${where}.${key} is required`);
      }
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
      fail(`${where}.name "${entry.name}" must be lowercase letters, digits and dashes`);
    }
    if (!PLATFORMS.has(entry.platform)) {
      fail(`${where}.platform "${entry.platform}" must be one of ${[...PLATFORMS].join(", ")}`);
    }
    if (!ROLES.has(entry.role)) fail(`${where}.role must be "builder" or "target"`);
    const daemon = entry.daemon ?? (entry.platform.startsWith("darwin") ? "desktop" : "systemd");
    if (!DAEMON_MODES.has(daemon)) fail(`${where}.daemon must be "systemd" or "desktop"`);
    const port = entry.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`${where}.port is invalid`);
    return {
      name: entry.name,
      ssh: entry.ssh,
      address: entry.address,
      dns: entry.dns ?? "",
      platform: entry.platform,
      role: entry.role,
      buildFrom: entry.buildFrom ?? "",
      daemon,
      port,
      tunnel: entry.tunnel ?? "",
      // Builders: where packaging stages + keeps tarballs (needs ~2 GiB free).
      artifactDir: entry.artifactDir ?? "~/.paseo/artifacts",
    };
  });

  const byName = new Map();
  for (const host of hosts) {
    if (byName.has(host.name)) fail(`duplicate host name "${host.name}"`);
    byName.set(host.name, host);
  }
  for (const host of hosts) {
    if (host.role === "target") {
      const builder = byName.get(host.buildFrom);
      if (!builder) fail(`target "${host.name}" needs buildFrom naming a builder`);
      if (builder.role !== "builder") fail(`"${host.name}".buildFrom must name a builder`);
      if (builder.platform !== host.platform) {
        fail(
          `"${host.name}" (${host.platform}) cannot use runtime from "${builder.name}" (${builder.platform})`,
        );
      }
      if (host.daemon !== "systemd") fail(`target "${host.name}" must use daemon "systemd"`);
    } else if (host.buildFrom) {
      fail(`builder "${host.name}" must not set buildFrom`);
    }
  }
  return hosts;
}

export function loadInventory(env = process.env) {
  const file = inventoryPath(env);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  return parseInventory(raw, file);
}

export function peersFor(hosts, name, env = process.env) {
  if (!hosts.some((host) => host.name === name)) fail(`unknown host "${name}"`);
  return hosts
    .filter((host) => host.name !== name)
    .map((host) => {
      const password = env[passwordVar(host.name)];
      if (!password) fail(`${passwordVar(host.name)} is not set (see ~/.paseo/deploy.env)`);
      return { name: host.name, url: `tcp://${host.address}:${host.port}`, password };
    });
}

function localAddresses() {
  return new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((info) => info && info.family === "IPv4")
      .map((info) => info.address),
  );
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function findHost(hosts, name) {
  return hosts.find((host) => host.name === name) ?? fail(`unknown host "${name}"`);
}

const COMMANDS = {
  validate(hosts) {
    for (const host of hosts) {
      const source = host.role === "target" ? ` <- ${host.buildFrom}` : "";
      console.log(
        `${host.name}\t${host.role}${source}\t${host.platform}\t${host.daemon}\t${host.address}`,
      );
    }
  },
  list(hosts, args) {
    const role = flag(args, "--role");
    const daemon = flag(args, "--daemon");
    for (const host of hosts) {
      if (role && host.role !== role) continue;
      if (daemon && host.daemon !== daemon) continue;
      console.log(host.name);
    }
  },
  field(hosts, [name, key]) {
    const host = findHost(hosts, name);
    if (!(key in host)) fail(`unknown field "${key}"`);
    process.stdout.write(String(host[key]));
  },
  self(hosts) {
    const mine = localAddresses();
    const self = hosts.find((host) => mine.has(host.address));
    process.stdout.write(self ? self.name : "");
  },
  targets(hosts, [builder]) {
    findHost(hosts, builder);
    for (const host of hosts) {
      if (host.role === "target" && host.buildFrom === builder) console.log(host.name);
    }
  },
  peers(hosts, [name]) {
    process.stdout.write(JSON.stringify(peersFor(hosts, name)));
  },
  "password-var"(hosts, [name]) {
    findHost(hosts, name);
    process.stdout.write(passwordVar(name));
  },
};

function main([command, ...args]) {
  const run = Object.hasOwn(COMMANDS, command ?? "") ? COMMANDS[command] : null;
  if (!run) fail(`unknown command "${command ?? ""}" (see header of scripts/deploy/fleet.mjs)`);
  run(loadInventory(), args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
