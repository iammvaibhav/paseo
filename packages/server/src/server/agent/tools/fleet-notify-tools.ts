import { z } from "zod";
import {
  PersistentNotifyEntrySchema,
  type PersistentNotifyEntry,
} from "@getpaseo/protocol/messages";
import { ensureValidJson } from "../../json-utils.js";
import type { PersistentNotify } from "../../mcp-fleet/persistent-notify.js";
import { FLEET_HOST_HINT_DESCRIPTION } from "../../peers/fleet-hosts.js";
import {
  resolvePeerDaemonClient,
  resolveTargetHost,
  type RegisterFleetControlToolsOptions,
} from "./fleet-control-tools.js";
import { executeFleetToolOnPeer } from "./fleet-wait.js";
import type { PaseoToolResult } from "./types.js";

export const PERSISTENT_NOTIFY_DESCRIPTION =
  "Callback targets the agent keeps for every turn, not just this call's: each entry is " +
  '{target: "<webhook name>" | {agent: "<agent id>"}, context?, messages?: "final" | "all", turns?: ' +
  '["prompt" | "callback" | "reminder" | "app"]}. turns filters by what started the turn: a fleet ' +
  "prompt, a callback (another agent's message or notification), a prompt after a reminder, or a " +
  'person in the app; omitted = every turn. messages "all" also streams intermediate messages when ' +
  "the target is configured with intermediateMessages; default is what the target takes. Each turn " +
  "calls back these entries plus the notifyTargets of the call that started it, once per target: " +
  "the call's notifyContext wins for that turn. Kept on the agent's record through restarts and archive.";

export const PersistentNotifyInputSchema = z
  .array(PersistentNotifyEntrySchema)
  .max(10)
  .describe(PERSISTENT_NOTIFY_DESCRIPTION);

export interface RegisterFleetNotifyToolsOptions extends RegisterFleetControlToolsOptions {
  /** Absent → this host cannot keep persistent targets for its own agents. */
  persistentNotify?: PersistentNotify | null;
}

const OUTPUT_SCHEMA = {
  ok: z.boolean(),
  host: z.string(),
  agentId: z.string(),
  persistentNotify: z.array(PersistentNotifyEntrySchema).optional(),
  error: z.string().optional(),
  guidance: z.string().optional(),
};

const PEER_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  persistentNotify: z.array(PersistentNotifyEntrySchema).optional(),
  error: z.string().optional(),
});

function result(structuredContent: Record<string, unknown>): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(structuredContent) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerFleetNotifyTools(options: RegisterFleetNotifyToolsOptions): void {
  options.registerTool(
    "fleet_set_agent_notify",
    {
      title: "Set an agent's persistent callbacks",
      description:
        "Replace the callback targets an agent keeps for its turns ([] clears them). Every turn the " +
        "agent starts from now on calls these back, including turns another agent's callback " +
        "starts, so a bot hears every turn of an agent it talks through. The turn running now is " +
        "covered too. fleet_agent_status shows the current entries. agentId is fleet-wide; host is " +
        "optional.",
      inputSchema: {
        agentId: z
          .string()
          .min(1)
          .describe("Agent UUID from fleet_list_agents data — fleet-wide, no host needed."),
        host: z.string().min(1).optional().describe(FLEET_HOST_HINT_DESCRIPTION),
        persistentNotify: PersistentNotifyInputSchema,
        turnId: z
          .string()
          .min(1)
          .optional()
          .describe("Also call back this turn; default the turn the agent is running now."),
      },
      outputSchema: OUTPUT_SCHEMA,
    },
    async (input: {
      agentId: string;
      host?: string;
      persistentNotify: PersistentNotifyEntry[];
      turnId?: string;
    }) => {
      const resolved = await resolveTargetHost(input.agentId, input.host, options);
      const base = { host: resolved.targetHostDisplay, agentId: resolved.agentId };
      if (resolved.error) {
        return result({ ok: false, ...base, error: resolved.error, guidance: resolved.guidance });
      }
      if (resolved.isLocal) {
        if (!options.persistentNotify) {
          return result({
            ok: false,
            ...base,
            error: "This host cannot keep persistent callbacks",
          });
        }
        try {
          await options.persistentNotify.set(
            resolved.agentId,
            input.persistentNotify,
            input.turnId ? { turnId: input.turnId } : undefined,
          );
          return result({ ok: true, ...base, persistentNotify: input.persistentNotify });
        } catch (error) {
          return result({ ok: false, ...base, error: errorMessage(error) });
        }
      }
      const peer = resolvePeerDaemonClient(resolved.host, options);
      if (!peer.client) {
        return result({ ok: false, ...base, error: peer.error, guidance: peer.guidance });
      }
      if (peer.client.getLastServerInfoMessage()?.features?.persistentNotify !== true) {
        return result({
          ok: false,
          ...base,
          error: `Host "${resolved.host}" cannot keep persistent callbacks; update Paseo there.`,
        });
      }
      try {
        const outcome = await executeFleetToolOnPeer(peer.client, "fleet_set_agent_notify", {
          agentId: resolved.agentId,
          persistentNotify: input.persistentNotify,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
        if (!outcome.ok) return result({ ok: false, ...base, error: outcome.error });
        return result({ ...PEER_RESULT_SCHEMA.parse(outcome.structuredContent), ...base });
      } catch (error) {
        return result({ ok: false, ...base, error: errorMessage(error) });
      }
    },
  );
}
