import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The Commander's identity label. Any agent carrying a `paseo.mission-control*`
 * label is hidden outside Mission Control; the `commander` value marks the one
 * durable routing agent the screen creates.
 */
export const MISSION_CONTROL_LABEL_KEY = "paseo.mission-control";
export const MISSION_CONTROL_LABEL_VALUE = "commander";

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
