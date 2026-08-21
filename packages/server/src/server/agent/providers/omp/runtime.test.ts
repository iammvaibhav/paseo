import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { OmpHarness } from "./test-utils/omp-harness.js";
import { buildOmpLaunch, TOOL_ALLOWLIST_CONFIG_OVERLAY } from "./runtime.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});

function buildArgs(session: Parameters<typeof buildOmpLaunch>[0]["session"]): string[] {
  return buildOmpLaunch({ command: ["omp"], session }).argv;
}

test("append mode (default) layers the prompt under the harness", () => {
  const argv = buildArgs({ cwd: "/tmp", systemPrompt: "Follow the plan" });
  expect(argv).toContain("--append-system-prompt");
  expect(argv).toContain("Follow the plan");
  expect(argv).not.toContain("--system-prompt");
});

test("replace mode swaps the harness out entirely", () => {
  const argv = buildArgs({
    cwd: "/tmp",
    systemPrompt: "You are the Commander",
    systemPromptMode: "replace",
  });
  expect(argv).toContain("--system-prompt");
  expect(argv).toContain("You are the Commander");
  expect(argv).not.toContain("--append-system-prompt");
});

test("tool allowlist with builtin names emits the selective --tools flag", () => {
  const argv = buildArgs({ cwd: "/tmp", toolAllowlist: ["read", "bash"] });
  expect(argv).toContain("--tools");
  expect(argv).toContain("read,bash");
  expect(argv).not.toContain("--no-tools");
});

test("tool allowlist with only Paseo host tools drops every builtin", () => {
  const argv = buildArgs({ cwd: "/tmp", toolAllowlist: ["create_agent", "fleet_list_agents"] });
  expect(argv).toContain("--no-tools");
  expect(argv).not.toContain("--tools");
});

test("tool allowlist pins omp harness-utility feature gates off via the config overlay", () => {
  // learn/manage_skill (autolearn), checkpoint/rewind (checkpoint) and the
  // SDK-injected tts (speechgen) register outside omp's builtin catalog, so
  // --no-tools cannot remove them. The launch must pass the overlay.
  const argv = buildArgs({ cwd: "/tmp", toolAllowlist: ["fleet_list_agents"] });
  const overlayIndex = argv.indexOf("--config");
  expect(overlayIndex).toBeGreaterThan(-1);
  expect(argv[overlayIndex + 1]).toBe(TOOL_ALLOWLIST_CONFIG_OVERLAY);
  const overlay = readFileSync(TOOL_ALLOWLIST_CONFIG_OVERLAY, "utf8");
  expect(overlay).toContain("autolearn");
  expect(overlay).toContain("checkpoint");
  expect(overlay).toContain("speechgen");
});

test("tool allowlist with builtin names still pins the config overlay", () => {
  const argv = buildArgs({ cwd: "/tmp", toolAllowlist: ["read", "bash"] });
  expect(argv).toContain("--config");
  expect(argv[argv.indexOf("--config") + 1]).toBe(TOOL_ALLOWLIST_CONFIG_OVERLAY);
});

test("empty allowlist and absent allowlist change nothing", () => {
  expect(buildArgs({ cwd: "/tmp", toolAllowlist: [] })).not.toContain("--no-tools");
  expect(buildArgs({ cwd: "/tmp" })).not.toContain("--no-tools");
  // No allowlist means no restriction, so the harness-utility gates stay as
  // the user configured them (no overlay).
  expect(buildArgs({ cwd: "/tmp", toolAllowlist: [] })).not.toContain("--config");
  expect(buildArgs({ cwd: "/tmp" })).not.toContain("--config");
});
