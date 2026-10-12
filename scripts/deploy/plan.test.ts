import { describe, expect, test } from "vitest";
import { parseInventory } from "./inventory.ts";
import type { Component, HostState, PlanInput } from "./plan.ts";
import { makePlan } from "./plan.ts";

const hosts = parseInventory(
  JSON.stringify({
    hosts: [
      {
        name: "mac",
        ssh: "mac",
        address: "10.0.0.1",
        platform: "darwin-arm64",
        role: "builder",
        services: ["omp"],
      },
      {
        name: "dev",
        ssh: "dev",
        address: "10.0.0.2",
        platform: "linux-arm64",
        role: "builder",
        services: ["omp", "code-server"],
      },
      { name: "work", ssh: "work", address: "10.0.0.3", platform: "linux-x64", role: "builder" },
      {
        name: "prod",
        ssh: "prod",
        address: "10.0.0.4",
        platform: "linux-arm64",
        role: "target",
        buildFrom: "dev",
        services: ["omp-proxy"],
      },
      {
        name: "dell",
        ssh: "dell",
        address: "10.0.0.5",
        platform: "linux-x64",
        role: "target",
        buildFrom: "work",
      },
    ],
  }),
);

const deployed: HostState = {
  daemon: "old",
  app: "old",
  "code-server": "old",
  "omp-proxy": "old",
  "omp-proxy-omp": "1.0.0",
};

function plan(changes: Component[], overrides: Partial<PlanInput> = {}) {
  const result = makePlan({
    hosts,
    self: "dev",
    mode: "all",
    selected: [],
    force: false,
    reachable: hosts.map((host) => host.name),
    states: Object.fromEntries(hosts.map((host) => [host.name, deployed])),
    vercelState: "old",
    vercelEnabled: true,
    ompTarget: "1.0.0",
    changed: (component, since) => since === undefined || changes.includes(component),
    ...overrides,
  });
  const work = Object.fromEntries(
    result.hosts.map(({ host, daemon, app, build, services }) => [
      host.name,
      [build && "build", app && "app", daemon && "daemon", ...services].filter(Boolean).join(","),
    ]),
  );
  return { ...result, work };
}

describe("deploy plan", () => {
  test("an unchanged fleet restarts nothing and builds nothing", () => {
    const { work, vercel, config } = plan([]);
    expect(work).toEqual({ mac: "", dev: "", work: "", prod: "", dell: "" });
    expect(vercel).toBe(false);
    expect(config).toBe(true);
  });

  test("a daemon change builds on each builder, restarts every daemon, and rebuilds the app", () => {
    const { work } = plan(["daemon", "app"]);
    expect(work).toEqual({
      mac: "app,daemon",
      dev: "build,daemon",
      work: "build,daemon",
      prod: "daemon",
      dell: "daemon",
    });
  });

  test("a UI-only change ships the app and Vercel without restarting a daemon", () => {
    const { work, vercel } = plan(["app", "vercel"]);
    expect(work).toEqual({ mac: "app", dev: "build", work: "", prod: "", dell: "" });
    expect(vercel).toBe(true);
  });

  test("a new host gets the runtime from its builder even when nothing changed", () => {
    const { dell: _, ...rest } = Object.fromEntries(hosts.map((host) => [host.name, deployed]));
    const { work } = plan([], { states: rest });
    expect(work.dell).toBe("daemon");
    expect(work.work).toBe("build");
    expect(work.prod).toBe("");
  });

  test("--hosts limits restarts to the named host; its builder only builds", () => {
    const { work } = plan(["daemon"], { selected: ["prod"] });
    expect(work).toEqual({ dev: "build", prod: "daemon" });
  });

  test("an unreachable builder is reported; its targets keep their runtime", () => {
    const { work, unreachable } = plan(["daemon"], { reachable: ["mac", "dev", "prod", "dell"] });
    expect(unreachable).toEqual(["work"]);
    expect(work.dell).toBe("");
    expect(work.work).toBeUndefined();
  });

  test("desktop mode only installs the app", () => {
    const { work, config, vercel } = plan(["daemon", "app", "vercel"], { mode: "desktop" });
    expect(work).toEqual({ mac: "app" });
    expect(config).toBe(false);
    expect(vercel).toBe(false);
  });

  test("a target that moved to a new address restarts on its new IP", () => {
    const states = Object.fromEntries(hosts.map((host) => [host.name, deployed]));
    states.dell = { ...deployed, address: "10.0.0.99" };
    expect(plan([], { states }).work.dell).toBe("daemon");
    states.dell = { ...deployed, address: "10.0.0.5" };
    expect(plan([], { states }).work.dell).toBe("");
  });

  test("the prod omp services follow a new omp release", () => {
    expect(plan([]).work.prod).toBe("");
    expect(plan([], { ompTarget: "1.1.0" }).work.prod).toBe("omp-proxy");
  });

  test("--force redeploys everything", () => {
    const { work } = plan([], { force: true });
    expect(work).toEqual({
      mac: "app,daemon",
      dev: "build,daemon,code-server",
      work: "build,daemon",
      prod: "daemon,omp-proxy",
      dell: "daemon",
    });
  });
});

test("the inventory refuses a target whose builder has another platform", () => {
  expect(() =>
    parseInventory(
      JSON.stringify({
        hosts: [
          {
            name: "dev",
            ssh: "dev",
            address: "10.0.0.2",
            platform: "linux-arm64",
            role: "builder",
          },
          {
            name: "dell",
            ssh: "dell",
            address: "10.0.0.5",
            platform: "linux-x64",
            role: "target",
            buildFrom: "dev",
          },
        ],
      }),
    ),
  ).toThrow(/cannot run "dev"'s linux-arm64 build/);
});
