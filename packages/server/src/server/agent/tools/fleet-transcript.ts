import { z } from "zod";
import type { Logger } from "pino";
import { ensureValidJson } from "../../json-utils.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
} from "../agent-timeline-store-types.js";
import { supportsDiskTimeline, tryReadProviderTimelineFromDisk } from "../provider-disk-history.js";
import {
  resolvePeerDaemonClient,
  resolveTargetHost,
  type RegisterFleetControlToolsOptions,
} from "./fleet-control-tools.js";

/**
 * Make an agent's stored timeline fetchable without ever spawning its
 * provider process: live agents already have one; closed agents are seeded
 * from offline provider disk history (or an empty timeline when there is
 * none). Returns the live agent when there is one.
 */
export async function seedStoredTimeline(input: {
  agentId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): Promise<{ provider: string; currentModeId: string | null }> {
  const live = input.agentManager.getAgent(input.agentId);
  if (live) {
    return { provider: live.provider, currentModeId: live.currentModeId };
  }
  const record = await input.agentStorage.get(input.agentId);
  if (!record) {
    throw new Error(`Agent ${input.agentId} not found`);
  }
  const seeded = await input.agentManager.seedTimelineForRehydrate(input.agentId, async () => {
    const sessionId = record.persistence?.sessionId;
    if (!sessionId || !supportsDiskTimeline(record.provider)) {
      return null;
    }
    return tryReadProviderTimelineFromDisk(
      {
        provider: record.provider,
        cwd: record.cwd,
        sessionId,
        ...(typeof record.persistence?.nativeHandle === "string"
          ? { nativeHandle: record.persistence.nativeHandle }
          : {}),
      },
      { logger: input.logger },
    );
  });
  if (!seeded && !input.agentManager.hasTimeline(input.agentId)) {
    input.agentManager.seedTimelineFromItems(input.agentId, []);
  }
  return { provider: record.provider, currentModeId: null };
}

const TRANSCRIPT_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "error",
  "compaction",
] as const;

const TRANSCRIPT_DEFAULT_LIMIT = 50;
const TRANSCRIPT_MAX_LIMIT = 200;
const TRANSCRIPT_DEFAULT_MAX_FIELD_CHARS = 8000;

/** The cursor is opaque to clients: base64url JSON of the timeline {epoch, seq}. */
function encodeTranscriptCursor(cursor: AgentTimelineCursor): string {
  return Buffer.from(JSON.stringify({ e: cursor.epoch, s: cursor.seq })).toString("base64url");
}
function decodeTranscriptCursor(value: string): AgentTimelineCursor {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    // Falls through to the schema error below.
  }
  const parsed = z.object({ e: z.string(), s: z.number().int().nonnegative() }).safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "cursor is not a fleet_get_transcript cursor; pass olderCursor/newerCursor verbatim",
    );
  }
  return { epoch: parsed.data.e, seq: parsed.data.s };
}

/** Cut every string longer than maxChars anywhere in the value; counts the cuts. */
function truncateLongStrings(
  value: unknown,
  maxChars: number,
  counter: { truncated: number },
): unknown {
  if (typeof value === "string") {
    if (value.length <= maxChars) return value;
    counter.truncated += 1;
    return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => truncateLongStrings(entry, maxChars, counter));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        truncateLongStrings(entry, maxChars, counter),
      ]),
    );
  }
  return value;
}

interface TranscriptPage {
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  startSeq: number | null;
  endSeq: number | null;
  entries: Array<{
    seqStart: number;
    seqEnd: number;
    turnId?: string;
    timestamp: string;
    item: { type: string };
  }>;
}

/** One timeline page from the host that owns the agent; never starts its provider. */
async function fetchTranscriptPage(
  options: RegisterFleetControlToolsOptions,
  target: { host: string; isLocal: boolean },
  request: {
    agentId: string;
    direction: AgentTimelineFetchDirection;
    cursor: AgentTimelineCursor | undefined;
    limit: number;
  },
): Promise<{ ok: true; page: TranscriptPage } | { ok: false; error: string; guidance?: string }> {
  const { agentId, direction, cursor, limit } = request;
  const fetchOptions = { direction, ...(cursor ? { cursor } : {}), limit };
  if (target.isLocal) {
    try {
      await seedStoredTimeline({
        agentId,
        agentManager: options.agentManager,
        agentStorage: options.agentStorage,
        logger: options.logger,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const fetched = options.agentManager.fetchTimeline(agentId, fetchOptions);
    return { ok: true, page: { ...fetched, entries: fetched.rows } };
  }
  const peer = resolvePeerDaemonClient(target.host, options);
  if (!peer.client) {
    return { ok: false, error: peer.error ?? "Peer unavailable", guidance: peer.guidance };
  }
  const payload = await peer.client.fetchAgentTimeline(agentId, fetchOptions);
  if (payload.error) {
    return { ok: false, error: payload.error };
  }
  return {
    ok: true,
    page: {
      epoch: payload.epoch,
      reset: payload.reset,
      staleCursor: payload.staleCursor,
      hasOlder: payload.hasOlder,
      hasNewer: payload.hasNewer,
      startSeq: payload.startCursor?.seq ?? null,
      endSeq: payload.endCursor?.seq ?? null,
      entries: payload.entries,
    },
  };
}

export function registerFleetTranscriptTool(options: RegisterFleetControlToolsOptions): void {
  options.registerTool(
    "fleet_get_transcript",
    {
      title: "Read an agent's full transcript",
      description:
        "Page through an agent's full transcript on any host: user and assistant messages, reasoning, and " +
        "tool calls with their input, output and error inline. Starts at the newest entries; pass olderCursor " +
        "back to page older, or newerCursor to read entries added since. Never starts a closed agent. " +
        "turnId and types filter within each page, so a page can hold fewer than limit entries.",
      inputSchema: {
        agentId: z
          .string()
          .min(1)
          .describe(
            "Agent UUID from fleet_list_agents/fleet_search data — fleet-wide, no host needed.",
          ),
        host: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional host hint (peer name or 'local'). Omitted → resolved via the fleet index.",
          ),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe("olderCursor or newerCursor from a previous page. Omitted → the newest page."),
        direction: z
          .enum(["older", "newer"])
          .optional()
          .describe("Which way to page from cursor (default older). Ignored without a cursor."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TRANSCRIPT_MAX_LIMIT)
          .optional()
          .describe(
            `Entries per page (default ${TRANSCRIPT_DEFAULT_LIMIT}, max ${TRANSCRIPT_MAX_LIMIT}).`,
          ),
        turnId: z.string().min(1).optional().describe("Only entries from this turn."),
        types: z
          .array(z.enum(TRANSCRIPT_ITEM_TYPES))
          .min(1)
          .optional()
          .describe("Only these entry types."),
        maxFieldChars: z
          .number()
          .int()
          .min(200)
          .optional()
          .describe(
            `Cut any text field longer than this (default ${TRANSCRIPT_DEFAULT_MAX_FIELD_CHARS}); cuts are counted in truncatedFields.`,
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        agentId: z.string(),
        host: z.string(),
        epoch: z.string().optional(),
        entries: z
          .array(
            z.object({
              seq: z.number(),
              seqEnd: z.number(),
              turnId: z.string().nullable(),
              timestamp: z.string(),
              item: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        olderCursor: z.string().nullable().optional(),
        newerCursor: z.string().nullable().optional(),
        hasOlder: z.boolean().optional(),
        hasNewer: z.boolean().optional(),
        reset: z.boolean().optional(),
        staleCursor: z.boolean().optional(),
        truncatedFields: z.number().optional(),
        error: z.string().optional(),
        guidance: z.string().optional(),
      },
    },
    async (input: {
      agentId: string;
      host?: string;
      cursor?: string;
      direction?: "older" | "newer";
      limit?: number;
      turnId?: string;
      types?: Array<(typeof TRANSCRIPT_ITEM_TYPES)[number]>;
      maxFieldChars?: number;
    }) => {
      const resolved = await resolveTargetHost(input.agentId, input.host, options);
      const { agentId } = resolved;
      const failure = (error: string, guidance?: string) => ({
        content: [],
        structuredContent: ensureValidJson({
          ok: false,
          agentId,
          host: resolved.targetHostDisplay,
          error,
          ...(guidance ? { guidance } : {}),
        }),
      });
      if (resolved.error) {
        return failure(resolved.error, resolved.guidance);
      }
      const cursor = input.cursor ? decodeTranscriptCursor(input.cursor) : undefined;
      let direction: AgentTimelineFetchDirection = "tail";
      if (cursor) direction = input.direction === "newer" ? "after" : "before";
      const fetched = await fetchTranscriptPage(options, resolved, {
        agentId,
        direction,
        cursor,
        limit: input.limit ?? TRANSCRIPT_DEFAULT_LIMIT,
      });
      if (!fetched.ok) {
        return failure(fetched.error, fetched.guidance);
      }
      const { page } = fetched;

      const types = input.types ? new Set<string>(input.types) : null;
      const counter = { truncated: 0 };
      const maxFieldChars = input.maxFieldChars ?? TRANSCRIPT_DEFAULT_MAX_FIELD_CHARS;
      const entries = page.entries
        .filter((entry) => (input.turnId ? entry.turnId === input.turnId : true))
        .filter((entry) => (types ? types.has(entry.item.type) : true))
        .map((entry) => ({
          seq: entry.seqStart,
          seqEnd: entry.seqEnd,
          turnId: entry.turnId ?? null,
          timestamp: entry.timestamp,
          item: truncateLongStrings(entry.item, maxFieldChars, counter),
        }));
      const olderCursor =
        page.hasOlder && page.startSeq !== null
          ? encodeTranscriptCursor({ epoch: page.epoch, seq: page.startSeq })
          : null;
      // Without new rows, keep the caller's position so polling newer never rewinds.
      const newerCursor =
        page.endSeq !== null
          ? encodeTranscriptCursor({ epoch: page.epoch, seq: page.endSeq })
          : (input.cursor ?? null);
      return {
        content: [],
        structuredContent: ensureValidJson({
          ok: true,
          agentId,
          host: resolved.targetHostDisplay,
          epoch: page.epoch,
          entries,
          olderCursor,
          newerCursor,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          reset: page.reset,
          staleCursor: page.staleCursor,
          truncatedFields: counter.truncated,
        }),
      };
    },
  );
}
