import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

/** Past this size the log rolls to `<path>.1`, replacing the previous roll. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * One POST to an MCP client's webhook. Every attempt is a row, retries
 * included; the attempts of one event share deliveryId.
 */
export interface WebhookDeliveryAttempt {
  ts: string;
  client: string;
  deliveryId: string;
  /** The finish watch (or status-report request) that sent the event. */
  watchId: string;
  /** The event type sent, e.g. paseo.agent.finished. */
  event: string;
  reason: string | null;
  agentId: string | null;
  groupId: string | null;
  turnId: string | null;
  context: string | null;
  /** Who started the turn ("user" or "tool"); absent on other events and older rows. */
  origin?: "user" | "tool";
  /** 1-based. */
  attempt: number;
  /** HTTP status; null when the request never got a response. */
  status: number | null;
  /** "retrying": this attempt failed and another follows. "failed": the event was given up on. */
  outcome: "delivered" | "retrying" | "failed";
  /** On a "retrying" row: when the next attempt is due. */
  nextAttemptAt?: string;
  /**
   * On a "failed" row: "exhausted" when every retry failed, "not_retryable"
   * when the receiver's answer (e.g. 401, 404, a 400 that is not rate limiting)
   * cannot succeed on resend. Absent on rows written before retries existed.
   */
  failure?: "exhausted" | "not_retryable";
  /** The start of the response body, or the network error. */
  response: string | null;
  durationMs: number;
}

export interface WebhookDeliveryQuery {
  client?: string;
  agentId?: string;
  /** Only attempts that did not deliver. */
  failedOnly?: boolean;
  /** ISO timestamp; only attempts at or after it. */
  since?: string;
  limit: number;
}

export interface WebhookDeliveryTotals {
  /** Events matched (distinct deliveryId). */
  events: number;
  delivered: number;
  failed: number;
  attempts: number;
  /** Attempts by HTTP status; "none" for attempts without a response. */
  byStatus: Record<string, number>;
}

export interface WebhookDeliveryLog {
  /** Queue a row; rows land in call order. A failed write is logged, never thrown. */
  append(attempt: WebhookDeliveryAttempt): void;
  /** Resolves once every queued row is on disk. */
  flush(): Promise<void>;
  /** Matching attempts, newest first, plus totals over every match (not just the returned page). */
  list(
    query: WebhookDeliveryQuery,
  ): Promise<{ totals: WebhookDeliveryTotals; deliveries: WebhookDeliveryAttempt[] }>;
}

const SentBodySchema = z.object({
  type: z.string(),
  reason: z.string().optional(),
  context: z.string().nullable().optional(),
  origin: z.enum(["user", "tool"]).optional(),
  agentId: z.string().optional(),
  groupId: z.string().optional(),
  agent: z.object({ id: z.string(), turnId: z.string().nullable().optional() }).optional(),
});

function parseSentBody(body: string): z.infer<typeof SentBodySchema> | null {
  try {
    const result = SentBodySchema.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** What a webhook body says it is about, read from the body actually sent. */
export function describeWebhookBody(
  body: string,
): Pick<
  WebhookDeliveryAttempt,
  "event" | "reason" | "agentId" | "groupId" | "turnId" | "context" | "origin"
> {
  const parsed = parseSentBody(body);
  if (!parsed) {
    return {
      event: "unknown",
      reason: null,
      agentId: null,
      groupId: null,
      turnId: null,
      context: null,
    };
  }
  return {
    event: parsed.type,
    reason: parsed.reason ?? null,
    agentId: parsed.agent?.id ?? parsed.agentId ?? null,
    groupId: parsed.groupId ?? null,
    turnId: parsed.agent?.turnId ?? null,
    context: parsed.context ?? null,
    ...(parsed.origin ? { origin: parsed.origin } : {}),
  };
}

export function createWebhookDeliveryLog(options: {
  path: string;
  logger: Logger;
  maxBytes?: number;
}): WebhookDeliveryLog {
  const { path: logPath, logger } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const rolledPath = `${logPath}.1`;
  let writes: Promise<void> = Promise.resolve();
  // Bytes in the current file; read from disk on the first write.
  let size: number | null = null;

  const write = async (attempt: WebhookDeliveryAttempt) => {
    const line = `${JSON.stringify(attempt)}\n`;
    try {
      if (size === null) {
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        size = await fs.stat(logPath).then(
          (stat) => stat.size,
          () => 0,
        );
      }
      if (size > 0 && size + line.length > maxBytes) {
        await fs.rename(logPath, rolledPath);
        size = 0;
      }
      await fs.appendFile(logPath, line, "utf8");
      size += Buffer.byteLength(line);
    } catch (error) {
      logger.error({ err: String(error), logPath }, "webhook delivery log write failed");
    }
  };

  const readRows = async (file: string): Promise<WebhookDeliveryAttempt[]> => {
    const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const rows: WebhookDeliveryAttempt[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as WebhookDeliveryAttempt);
      } catch {
        // A torn final line from a crash mid-append.
      }
    }
    return rows;
  };

  return {
    append(attempt) {
      writes = writes.then(() => write(attempt));
    },

    flush: () => writes,

    async list(query) {
      await writes;
      const rows = [...(await readRows(rolledPath)), ...(await readRows(logPath))];
      const since = query.since ? Date.parse(query.since) : null;
      const matches = rows.filter(
        (row) =>
          (!query.client || row.client === query.client) &&
          (!query.agentId || row.agentId === query.agentId) &&
          (since === null || Date.parse(row.ts) >= since) &&
          (!query.failedOnly || row.outcome !== "delivered"),
      );
      const totals: WebhookDeliveryTotals = {
        events: new Set(matches.map((row) => row.deliveryId)).size,
        delivered: 0,
        failed: 0,
        attempts: matches.length,
        byStatus: {},
      };
      for (const row of matches) {
        if (row.outcome === "delivered") totals.delivered += 1;
        if (row.outcome === "failed") totals.failed += 1;
        const key = row.status === null ? "none" : String(row.status);
        totals.byStatus[key] = (totals.byStatus[key] ?? 0) + 1;
      }
      return { totals, deliveries: matches.toReversed().slice(0, query.limit) };
    },
  };
}
