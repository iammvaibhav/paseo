import type { Logger } from "pino";
import type { MissionControlRunRecord } from "./run-records.js";
import { runRecordDocumentId, runRecordTags } from "./run-records.js";

/**
 * M6 context architecture: the Hindsight fleet memory bank client. A small
 * dependency-free HTTP client (fetch + timeouts) that writes finalized run
 * records to the configured Hindsight bank and recalls over it. Never blocks
 * anything: failures are logged at most once per interval and swallowed.
 *
 * Wire contract (probed from the Hindsight instance's /openapi.json):
 * - write:  POST {url}/v1/default/banks/{bank}/memories  { items: [{ content, timestamp, tags }] }
 * - recall: POST {url}/v1/default/banks/{bank}/memories/recall  { query, budget, max_tokens }
 * - ensure: PUT  {url}/v1/default/banks/{bank}  (idempotent create-or-update)
 */

export interface HindsightRecallMatch {
  id: string;
  text: string;
  context: string | null;
  occurredStart: string | null;
  documentId: string | null;
  tags: string[] | null;
  /** The bank this match was recalled from (source attribution for merged recalls). */
  bank: string;
  /**
   * omp-bank extras: transcript memories carry the omp session id (the SAME
   * id Paseo stores in an agent's persistence handle, so matches are
   * attributable to agents) plus `entities` naming agents/workspaces. Null on
   * fleet-bank run records, which instead carry a `paseo-run:*` documentId.
   */
  sessionId: string | null;
  entities: string[] | null;
  /** Raw recall metadata passthrough (omp memories carry `{ session_id }`). */
  metadata: Record<string, unknown> | null;
}

export type HindsightRecallResult =
  | { ok: true; matches: HindsightRecallMatch[] }
  | { ok: false; reason: "memory unavailable"; error: string };

export interface HindsightClientOptions {
  logger: Logger;
  /** Per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Minimum interval between failure logs (default 5 min). */
  logIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class HindsightClient {
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly logIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastFailureLogAt = 0;
  private readonly ensuredBanks = new Set<string>();

  constructor(options: HindsightClientOptions) {
    this.logger = options.logger.child({ module: "mission-control", component: "hindsight" });
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.logIntervalMs = options.logIntervalMs ?? 5 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Hindsight base URL is enabled (configured and non-empty). */
  static isEnabled(url: string | null | undefined): url is string {
    return typeof url === "string" && url.trim().length > 0;
  }

  /**
   * Write one finalized run record to the bank, tagged host/project/workspace/
   * agent. Idempotent: the memory carries the stable run document id, so a
   * re-write (e.g. a verdict landing after the first write) updates rather
   * than duplicates the run's memory.
   */
  async writeRunRecord(input: {
    url: string;
    bank: string;
    record: MissionControlRunRecord;
  }): Promise<void> {
    const { url, bank, record } = input;
    const base = url.replace(/\/+$/, "");
    try {
      if (!this.ensuredBanks.has(bank)) {
        await this.request(`${base}/v1/default/banks/${encodeURIComponent(bank)}`, {
          method: "PUT",
          body: "{}",
        });
        this.ensuredBanks.add(bank);
      }
      const payload = {
        items: [
          {
            content: buildRunRecordContent(record),
            timestamp: record.endedAt,
            document_id: runRecordDocumentId(record),
            tags: runRecordTags(record),
          },
        ],
      };
      await this.request(`${base}/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      this.logger.debug(
        { agentId: record.agentId, runEpoch: record.runEpoch, bank },
        "mission_control.hindsight.write_done",
      );
    } catch (error) {
      this.logFailureThrottled("mission_control.hindsight.write_failed", error);
    }
  }

  /** Semantic recall over the configured bank; never throws. */
  async recall(input: {
    url: string;
    bank: string;
    query: string;
    limit?: number;
  }): Promise<HindsightRecallResult> {
    const base = input.url.replace(/\/+$/, "");
    try {
      const payload = {
        query: input.query,
        budget: "low",
        max_tokens: 1024,
      };
      const response = await this.request(
        `${base}/v1/default/banks/${encodeURIComponent(input.bank)}/memories/recall`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      const rawResults = Array.isArray(response.results) ? response.results : [];
      const matches = rawResults
        .slice(0, input.limit ?? 5)
        .map((value) => Object.assign(toRecallMatch(value), { bank: input.bank }));
      return { ok: true, matches };
    } catch (error) {
      this.logFailureThrottled("mission_control.hindsight.recall_failed", error);
      return { ok: false, reason: "memory unavailable", error: String(error) };
    }
  }

  private async request(
    url: string,
    options: { method: string; body: string },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers: { "content-type": "application/json" },
        body: options.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Hindsight ${options.method} ${url} -> ${response.status} ${text.slice(0, 200)}`,
        );
      }
      if (response.status === 204) {
        return {};
      }
      const parsed: unknown = await response.json().catch(() => ({}));
      return isRecord(parsed) ? parsed : {};
    } finally {
      clearTimeout(timer);
    }
  }

  private logFailureThrottled(component: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < this.logIntervalMs) {
      return;
    }
    this.lastFailureLogAt = now;
    this.logger.warn({ err: error, component }, "mission_control.hindsight.unavailable");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecallMatch(value: unknown): HindsightRecallMatch {
  if (!isRecord(value)) {
    return {
      id: "unknown",
      text: String(value),
      context: null,
      occurredStart: null,
      documentId: null,
      tags: null,
      bank: "",
      sessionId: null,
      entities: null,
      metadata: null,
    };
  }
  const tags = Array.isArray(value["tags"])
    ? value["tags"].filter((t): t is string => typeof t === "string")
    : null;
  const metadata = isRecord(value["metadata"]) ? value["metadata"] : null;
  const sessionId =
    metadata !== null && typeof metadata["session_id"] === "string" ? metadata["session_id"] : null;
  const entities = Array.isArray(value["entities"])
    ? value["entities"].filter((e): e is string => typeof e === "string")
    : null;
  return {
    id: typeof value["id"] === "string" ? value["id"] : "unknown",
    text: typeof value["text"] === "string" ? value["text"] : "",
    context: typeof value["context"] === "string" ? value["context"] : null,
    occurredStart: typeof value["occurred_start"] === "string" ? value["occurred_start"] : null,
    documentId: typeof value["document_id"] === "string" ? value["document_id"] : null,
    tags,
    bank: "",
    sessionId,
    entities,
    metadata,
  };
}

/** The compact text persisted as the run's memory (recalled verbatim). */
export function buildRunRecordContent(record: MissionControlRunRecord): string {
  const lines = [
    `Paseo run record: ${record.agentName} (agent ${record.agentId}, run ${record.runEpoch}) on ${record.hostAlias}`,
    `Ran: ${record.startedAt.slice(0, 19).replace("T", " ")} → ${record.endedAt.slice(0, 19).replace("T", " ")} — ${record.outcome}`,
  ];
  if (record.workspaceTitle || record.projectName) {
    lines.push(
      `Placement: ${[record.projectName, record.workspaceTitle].filter(Boolean).join(" / ")}`,
    );
  }
  if (record.brief) {
    lines.push(`Brief: ${record.brief}`);
  }
  if (record.reports.length > 0) {
    lines.push("Report history:");
    for (const report of record.reports) {
      const kind = report.reportKind ?? report.kind;
      lines.push(
        `- [${report.ts.slice(0, 19).replace("T", " ")}] ${kind}: ${report.headline}${report.detail ? ` — ${report.detail}` : ""}`,
      );
    }
  }
  if (record.verdict) {
    lines.push(`Verdict (${record.verdict.by}): ${record.verdict.summary}`);
  }
  if (record.proofs.length > 0) {
    lines.push(
      `Proofs: ${record.proofs
        .map((proof) => (proof.label ?? proof.kind) + (proof.url ? ` (${proof.url})` : ""))
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}
