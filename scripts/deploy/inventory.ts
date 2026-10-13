// Fleet inventory: ~/.paseo/fleet-hosts.json on the host that runs deploy
// (never committed). One entry per machine; adding a machine is one entry plus
// a deploy. Format: scripts/deploy/fleet-hosts.example.json.
//
// builder  has a checkout and builds. Linux builders run their own package
//          under systemd; the desktop builder (MacBook) installs Paseo.app.
// target   no checkout, no build: runs the package of its `buildFrom` builder
//          (same platform) under systemd.
import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";

export type Platform = "linux-arm64" | "linux-x64" | "darwin-arm64" | "darwin-x64";
export type Service =
  | "omp"
  | "code-server"
  | "voice"
  | "stall-cron"
  | "macbook-watch"
  | "omp-proxy";

export interface Host {
  name: string;
  ssh: string;
  address: string;
  dns: string;
  /** Extra DNS names that resolve to this host (e.g. NetBird custom-zone records). */
  hostnames: string[];
  platform: Platform;
  role: "builder" | "target";
  buildFrom: string;
  daemon: "systemd" | "desktop";
  port: number;
  tunnel: "" | "cloudflared" | "tailscale-funnel";
  /** Builders: where packaging stages and keeps the newest tarball. */
  artifactDir: string;
  services: Service[];
}

const PLATFORMS: Record<string, true> = {
  "linux-arm64": true,
  "linux-x64": true,
  "darwin-arm64": true,
  "darwin-x64": true,
};
// Value = whether the service runs from the host's checkout (builders only).
// The rest run from the kit deploy ships to every host.
const SERVICES: Record<string, boolean> = {
  omp: false,
  "code-server": false,
  "stall-cron": false,
  "omp-proxy": false,
  // npm-installs its own dependencies from the checkout
  voice: true,
  // runs scripts/deploy.sh from the checkout
  "macbook-watch": true,
};

function fail(message: string): never {
  throw new Error(`fleet inventory: ${message}`);
}

function text(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.trim() === "") fail(`${where}.${key} is required`);
  return value;
}

function optional(entry: Record<string, unknown>, key: string, fallback: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : fallback;
}

// A DNS name, or a leading-dot pattern (".example.com") the daemon allowlist accepts.
const DNS_NAME = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function parseHostnames(entry: Record<string, unknown>, where: string): string[] {
  const value = entry.hostnames ?? [];
  if (
    !Array.isArray(value) ||
    !value.every((name): name is string => typeof name === "string" && DNS_NAME.test(name))
  ) {
    fail(`${where}.hostnames must be a list of DNS names`);
  }
  return value;
}

function parseServices(entry: Record<string, unknown>, role: string, where: string): Service[] {
  const services = entry.services ?? [];
  if (!Array.isArray(services)) fail(`${where}.services must be an array`);
  for (const service of services) {
    if (typeof service !== "string" || !Object.hasOwn(SERVICES, service)) {
      fail(`${where}.services: unknown service "${String(service)}"`);
    }
    if (role === "target" && SERVICES[service]) {
      fail(`${where}: "${service}" needs a checkout, so only a builder can run it`);
    }
  }
  return services as Service[];
}

function parseHost(entry: Record<string, unknown>, where: string): Host {
  const name = text(entry, "name", where);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    fail(`${where}.name must be lowercase letters, digits, dashes`);
  const platform = text(entry, "platform", where);
  if (!Object.hasOwn(PLATFORMS, platform)) fail(`${where}.platform "${platform}" is not supported`);
  const role = text(entry, "role", where);
  if (role !== "builder" && role !== "target") fail(`${where}.role must be "builder" or "target"`);
  const daemon = optional(entry, "daemon", platform.startsWith("darwin") ? "desktop" : "systemd");
  if (daemon !== "systemd" && daemon !== "desktop") fail(`${where}.daemon is invalid`);
  const port = entry.port ?? 6767;
  if (typeof port !== "number" || !Number.isInteger(port)) fail(`${where}.port is invalid`);
  const tunnel = optional(entry, "tunnel", "");
  if (tunnel !== "" && tunnel !== "cloudflared" && tunnel !== "tailscale-funnel") {
    fail(`${where}.tunnel must be "cloudflared" or "tailscale-funnel"`);
  }
  return {
    name,
    ssh: text(entry, "ssh", where),
    address: text(entry, "address", where),
    dns: optional(entry, "dns", ""),
    hostnames: parseHostnames(entry, where),
    platform: platform as Platform,
    role,
    buildFrom: optional(entry, "buildFrom", ""),
    daemon,
    port,
    tunnel,
    artifactDir: optional(entry, "artifactDir", "~/.paseo/artifacts"),
    services: parseServices(entry, role, where),
  };
}

export const INVENTORY_PATH = path.join(homedir(), ".paseo", "fleet-hosts.json");

export function parseInventory(raw: string, source = "inventory"): Host[] {
  let data: { hosts?: unknown };
  try {
    data = JSON.parse(raw) as { hosts?: unknown };
  } catch (error) {
    fail(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(data.hosts) || data.hosts.length === 0) {
    fail(`${source} must contain a non-empty "hosts" array`);
  }
  const hosts = data.hosts.map((entry, index) =>
    parseHost(entry as Record<string, unknown>, `hosts[${index}]`),
  );
  const byName = new Map<string, Host>();
  for (const host of hosts) {
    if (byName.has(host.name)) fail(`duplicate host name "${host.name}"`);
    byName.set(host.name, host);
  }
  for (const host of hosts) {
    if (host.role === "builder") {
      if (host.buildFrom) fail(`builder "${host.name}" must not set buildFrom`);
      continue;
    }
    const builder = byName.get(host.buildFrom);
    if (!builder || builder.role !== "builder") {
      fail(`target "${host.name}" needs buildFrom naming a builder`);
    }
    if (builder.platform !== host.platform) {
      fail(
        `"${host.name}" (${host.platform}) cannot run "${builder.name}"'s ${builder.platform} build`,
      );
    }
    if (host.daemon !== "systemd") fail(`target "${host.name}" must use daemon "systemd"`);
  }
  return hosts;
}

export function loadInventory(file = INVENTORY_PATH): Host[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read ${file}: ${(error as Error).message}`);
  }
  return parseInventory(raw, file);
}

/** The inventory entry whose address is bound on this machine. */
export function selfHost(hosts: Host[]): Host {
  const mine = new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((info) => info?.family === "IPv4")
      .map((info) => info?.address),
  );
  return (
    hosts.find((host) => mine.has(host.address)) ??
    fail("this machine is not in the inventory (no entry's address is bound here)")
  );
}

export function passwordVar(name: string): string {
  return `PASEO_HOST_PASSWORD_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Every DNS name the host's daemon must accept in the Host header (daemon.hostnames). */
export function daemonHostnames(host: Host): string[] {
  return [...new Set([host.dns, ...host.hostnames].filter((name) => name !== ""))];
}

export interface PeerEntry {
  name: string;
  url: string;
  password: string;
}

/** Full mesh: every other host, by NetBird address. */
export function peersFor(hosts: Host[], name: string, env: NodeJS.ProcessEnv): PeerEntry[] {
  return hosts
    .filter((host) => host.name !== name)
    .map((host) => {
      const password = env[passwordVar(host.name)];
      if (!password) fail(`${passwordVar(host.name)} is not set (see ~/.paseo/deploy.env)`);
      return { name: host.name, url: `tcp://${host.address}:${host.port}`, password };
    });
}
