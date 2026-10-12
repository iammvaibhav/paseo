// What a deploy does to each host, decided before anything runs.
//
// Each host stores the commit it last received per component in
// ~/.paseo/deploy-state.json. A component is redeployed only when a file in its
// paths changed since that commit (or it was never deployed, or --force). So a
// UI-only commit rebuilds the desktop app and Vercel but restarts no daemon.
import type { Host, Service } from "./inventory.ts";

const NOT_TESTS = [
  ":(exclude,glob)**/*.test.*",
  ":(exclude,glob)**/*.spec.*",
  ":(exclude,glob)**/e2e/**",
];

// What the daemon runs. Dependency changes always show up in pnpm-lock.yaml;
// deploy tooling (scripts/deploy/**) changes how a release is installed, not
// what it runs, so it never restarts a daemon on its own.
const DAEMON_PATHS = [
  "packages/server",
  "packages/cli",
  "packages/client",
  "packages/protocol",
  "packages/relay",
  "packages/highlight",
  "packages/plugin",
  "pnpm-lock.yaml",
  "patches",
  "scripts/postinstall-patches.mjs",
];

const APP_UI_PATHS = ["packages/app", "packages/expo-two-way-audio"];

/** Git pathspecs per component. */
export const COMPONENT_PATHS = {
  daemon: [...DAEMON_PATHS, ...NOT_TESTS],
  // The desktop app bundles the daemon, so daemon changes rebuild it too.
  app: [...DAEMON_PATHS, ...APP_UI_PATHS, "packages/desktop", ...NOT_TESTS],
  vercel: [
    ...APP_UI_PATHS,
    "packages/client",
    "packages/protocol",
    "packages/highlight",
    "packages/plugin",
    "packages/relay",
    "pnpm-lock.yaml",
    ...NOT_TESTS,
  ],
  "code-server": ["scripts/code-server"],
  plannotator: ["scripts/plannotator"],
  voice: ["scripts/commander-voice"],
  "omp-proxy": ["scripts/omp-proxy", "plugins"],
} satisfies Record<string, string[]>;

export type Component = keyof typeof COMPONENT_PATHS;

/** Services that are redeployed only when their files changed. */
const TRACKED_SERVICES: Partial<Record<Service, Component>> = {
  "code-server": "code-server",
  plannotator: "plannotator",
  voice: "voice",
  "omp-proxy": "omp-proxy",
};

/** Per-host record of what it last received: component → commit. */
export type HostState = Partial<Record<Component | "omp-proxy-omp", string>>;

export interface PlanInput {
  hosts: Host[];
  self: string;
  mode: "all" | "desktop";
  /** --hosts; empty = every host. */
  selected: string[];
  force: boolean;
  /** Hosts whose state could be read over ssh. */
  reachable: string[];
  states: Record<string, HostState>;
  vercelState: string | undefined;
  vercelEnabled: boolean;
  ompTarget: string;
  /** True when a file of `component` changed since `since` (undefined = never deployed). */
  changed: (component: Component, since: string | undefined) => boolean;
}

export interface HostPlan {
  host: Host;
  /** Linux: activate a new package (restart). Desktop: restart after the app install. */
  daemon: boolean;
  /** Desktop builder: build + install Paseo.app. */
  app: boolean;
  /** Builder: sync checkout + build + package (also for its targets or Vercel). */
  build: boolean;
  /** Tracked services whose files changed. */
  services: Service[];
  /** Idempotent per-run steps (omp update/plugins, stall cron, tunnel, watch). */
  routine: boolean;
}

export interface Plan {
  hosts: HostPlan[];
  unreachable: string[];
  /** Publish the web app export to Vercel. */
  vercel: boolean;
  /** Write peers + system prompt to every reachable daemon and reload. */
  config: boolean;
}

/** What a selected, reachable host needs on its own (builds are added later). */
function planHost(input: PlanInput, host: Host): HostPlan {
  const plan: HostPlan = {
    host,
    daemon: false,
    app: false,
    build: false,
    services: [],
    routine: false,
  };
  if (input.mode === "desktop") {
    plan.app = host.daemon === "desktop";
    return plan;
  }
  const state = input.states[host.name] ?? {};
  const due = (component: Component) => input.force || input.changed(component, state[component]);
  plan.routine = true;
  // A target needs its builder's package; without the builder it keeps running what it has.
  const builderReachable = host.role === "builder" || input.reachable.includes(host.buildFrom);
  plan.daemon = builderReachable && due("daemon");
  plan.app = host.daemon === "desktop" && due("app");
  for (const service of host.services) {
    const component = TRACKED_SERVICES[service];
    const ompStale = service === "omp-proxy" && state["omp-proxy-omp"] !== input.ompTarget;
    if (component && (due(component) || ompStale)) plan.services.push(service);
  }
  return plan;
}

/** Vercel ships the web export a Linux builder makes; publish from that host only. */
function publishesVercel(input: PlanInput, self: Host | undefined): boolean {
  if (input.mode !== "all" || !input.vercelEnabled) return false;
  if (self?.role !== "builder" || self.daemon !== "systemd") return false;
  return input.force || input.changed("vercel", input.vercelState);
}

export function makePlan(input: PlanInput): Plan {
  const reachable = new Set(input.reachable);
  const selected = input.hosts.filter((host) =>
    input.mode === "desktop"
      ? host.daemon === "desktop"
      : input.selected.length === 0 || input.selected.includes(host.name),
  );
  const plans = new Map<string, HostPlan>();
  for (const host of selected) {
    if (reachable.has(host.name)) plans.set(host.name, planHost(input, host));
  }

  const vercel = publishesVercel(input, plans.get(input.self)?.host);

  // A Linux builder builds when it, one of its targets, or Vercel needs a build.
  // A builder that is not selected still builds for its selected targets.
  for (const host of input.hosts) {
    if (host.role !== "builder" || host.daemon !== "systemd" || !reachable.has(host.name)) continue;
    const needed =
      plans.get(host.name)?.daemon ||
      (vercel && host.name === input.self) ||
      input.hosts.some(
        (target) => target.buildFrom === host.name && plans.get(target.name)?.daemon,
      );
    if (!needed) continue;
    const plan = plans.get(host.name) ?? {
      host,
      daemon: false,
      app: false,
      build: false,
      services: [],
      routine: false,
    };
    plan.build = true;
    plans.set(host.name, plan);
  }

  return {
    hosts: input.hosts.flatMap((host) => plans.get(host.name) ?? []),
    unreachable: selected.filter((host) => !reachable.has(host.name)).map((host) => host.name),
    vercel,
    config: input.mode === "all" && plans.size > 0,
  };
}

export function describePlan(plan: Plan): string[] {
  const lines: string[] = [];
  for (const { host, daemon, app, build, services, routine } of plan.hosts) {
    const work: string[] = [];
    if (build) work.push("build + package");
    if (app) work.push("build + install Paseo.app");
    if (daemon)
      work.push(host.daemon === "desktop" ? "restart daemon" : "activate new runtime (restart)");
    if (services.length > 0) work.push(`update ${services.join(", ")}`);
    if (routine && host.services.includes("omp")) work.push("omp update + plugins");
    lines.push(
      `  ${host.name.padEnd(12)} ${work.length > 0 ? work.join("; ") : "nothing changed"}`,
    );
  }
  for (const name of plan.unreachable) lines.push(`  ${name.padEnd(12)} UNREACHABLE (skipped)`);
  if (plan.vercel) lines.push("  vercel       publish web app");
  if (plan.config) lines.push("  all daemons  peers + system prompt, then `paseo daemon reload`");
  return lines;
}
