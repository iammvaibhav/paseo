import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";

/**
 * The Commander's identity label. Any agent carrying a `paseo.mission-control*`
 * label is hidden outside Mission Control; the `commander` value marks the one
 * durable routing agent the screen creates.
 */
export const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
export const MISSION_CONTROL_LABEL_VALUE = "commander";

/**
 * Commander adoption marker (verifier scope "commander"): set on a worker the
 * Commander has taken over by sending it work (`fleet_send_prompt`). Value is
 * the ISO timestamp of the FIRST adoption — the moment the Commander took
 * over — which the verifier uses to bound audits to work finished AFTER
 * adoption (an agent the user started and finished on its own is never
 * audited). Idempotent by construction: repeated sends never rewrite it.
 * Deliberately distinct from `paseo.parent-agent-id`: adoption is not
 * parentage (the Commander did not spawn the agent).
 */
export const COMMANDER_ADOPTED_AT_LABEL = "paseo.commander-adopted-at";

/**
 * The Commander's hard tool restriction (spec: Commander contract, user
 * decision "fleet-wide only"). Only Paseo FLEET tools — no host-specific
 * tools, no bash, no file editing, no task subagents — so the Commander can
 * never act on only its own host by accident. `fleet_create_agent` is the
 * superset spawn (host accepts "local"); every per-agent read has a fleet_
 * variant; the four dropped local tools (get_agent_status, create_workspace,
 * list_workspaces, history_search) are covered by fleet_list_agents /
 * fleet_get_agent_activity / fleet_create_agent placement / fleet_search.
 * M4 added the interaction tools `clarify` + `post_answer` (cards TO the
 * user — never gated, never side effects) and M5 adds `fleet_meta` (the
 * gated meta actions; implemented in the meta-actions module).
 * M6 adds the read-only context tools `fleet_recall` (semantic recall over
 * the Hindsight fleet memory bank; degrades to "memory unavailable" when the
 * bank is unreachable) and `fleet_context` (run records / workspace+project
 * rollups from the local store) — never gated, never side effects.
 * M7 adds `fleet_list_models` (per-host invocable model lists + each host's
 * default worker model, so a spawn never needs the user to name a model) —
 * read-only, never gated.
 * M8 adds `fleet_list_inventory` (hosts + projects + workspaces with an
 * optional fuzzy name filter, the catalog lookup for resolving a spoken name
 * before acting) — read-only, never gated.
 * Mirrors the app-side launch allowlist. The omp provider launches with
 * `--no-tools` for this list (no builtin names), dropping the omp `task`
 * subagent tool entirely.
 */
export const COMMANDER_TOOL_ALLOWLIST: readonly string[] = [
  "fleet_list_agents",
  "fleet_list_models",
  "fleet_list_inventory",
  "fleet_create_agent",
  "fleet_send_prompt",
  "fleet_get_agent_activity",
  "fleet_search",
  "tag_message",
  "clarify",
  "post_answer",
  "fleet_meta",
  "fleet_recall",
  "fleet_context",
];

/**
 * The static Commander system prompt, shipped as a repo markdown file
 * (commander-prompt.md) and bundled into the server dist beside this module at
 * build time (see packages/server/package.json build:lib). The prompt is
 * fleet-state-free by construction: identity, playbook, safety, and tool
 * contract only. Dynamic worldview (fleet map, roster, routing defaults) rides
 * the context pack, delivered as the first conversation message. Central
 * commanderInstructions append on top at build time, never here.
 */
export function readBundledCommanderPrompt(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "commander-prompt.md"), "utf8");
}

/**
 * Build the Commander's system prompt: the bundled shipped prompt plus any
 * central commanderInstructions appended on top.
 */
export function buildCommanderSystemPrompt(commanderInstructions?: string): string {
  const shipped = readBundledCommanderPrompt().trim();
  const instructions = commanderInstructions?.trim();
  return instructions ? `${shipped}\n\n${instructions}` : shipped;
}

/**
 * The Commander's launch contract, re-derived from the CURRENT build for the
 * commander-labeled agent (label value "commander" — NOT verifiers, which
 * carry their own launch contract): systemPromptMode "replace" with the
 * bundled Commander prompt and the hard tool allowlist. This is the single
 * source of truth for the contract so a Commander session NEVER comes back
 * from a reload/resume with the default coding-agent prompt or an
 * unrestricted tool catalog — not even when its stored record predates
 * contract persistence (live incident: a running Commander resumed with the
 * default prompt + full catalog because its record carried no
 * systemPromptMode/toolAllowlist). `commanderInstructions` (current central
 * config, when available) keeps user overrides fresh on reload instead of
 * freezing the spawn-time snapshot.
 */
export function applyCommanderLaunchContract(
  config: AgentSessionConfig,
  labels: Record<string, string> | undefined,
  commanderInstructions?: string,
): AgentSessionConfig {
  if (!labels || labels[MISSION_CONTROL_LABEL_KEY] !== MISSION_CONTROL_LABEL_VALUE) {
    return config;
  }
  return {
    ...config,
    systemPromptMode: "replace",
    systemPrompt: buildCommanderSystemPrompt(commanderInstructions),
    toolAllowlist: [...COMMANDER_TOOL_ALLOWLIST],
  };
}
