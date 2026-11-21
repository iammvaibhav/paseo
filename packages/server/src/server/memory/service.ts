import type { Logger } from "pino";
import type { MissionControlRunRecord } from "../mission-control/run-records.js";
import type { ExtractedChunk } from "../search/extract.js";
import { MemoryOutbox, type OutboxTransport } from "./outbox.js";
import { buildTurnItems, type TurnSource } from "./turns.js";
import type { MemoryItem, MemoryNoteInput, MemorySearchInput } from "./types.js";
import { splitAgentModeBlock } from "@getpaseo/protocol/agent-modes";

const REQUEST_TIMEOUT_MS = 15_000;

export class MemoryUnavailableError extends Error {}

/** HTTP client for the fleet-memory service (memory.url in config.json). */
export class MemoryClient implements OutboxTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MemoryUnavailableError(
        `fleet-memory at ${this.baseUrl} is unreachable: ${String(error)}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new MemoryUnavailableError(
        `fleet-memory ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }

  async ingest(items: MemoryItem[]): Promise<void> {
    await this.call("POST", "/v1/ingest", { items });
  }

  writeNote(note: MemoryNoteInput): Promise<unknown> {
    return this.call("POST", "/v1/notes", note);
  }

  search(input: MemorySearchInput): Promise<unknown> {
    return this.call("POST", "/v1/search", input);
  }

  getDoc(id: string): Promise<unknown> {
    return this.call("GET", `/v1/doc/${encodeURIComponent(id).replace(/%3A/g, ":")}`);
  }

  playbook(): Promise<unknown> {
    return this.call("GET", "/v1/playbook");
  }
}

export interface MemoryServiceDependencies {
  paseoHome: string;
  logger: Logger;
  /** fleet-memory base URL from config.json (memory.url); null → memory off on this host. */
  getMemoryUrl: () => string | null;
  hostLabel: () => string;
}

/**
 * This daemon's side of fleet-memory: reads and note writes go to the service
 * directly; every background write (turns, run records, learnings) goes through
 * the durable outbox so a sleeping memory host never loses or blocks anything.
 */
export class MemoryService {
  private outbox: MemoryOutbox | null = null;
  private client: MemoryClient | null = null;
  private clientUrl: string | null = null;

  constructor(private readonly deps: MemoryServiceDependencies) {}

  async start(): Promise<void> {
    this.outbox = await MemoryOutbox.open({
      paseoHome: this.deps.paseoHome,
      transport: () => this.currentClient(),
      logger: this.deps.logger,
    });
    this.outbox?.start();
  }

  stop(): void {
    this.outbox?.stop();
  }

  /** The client for the configured URL, rebuilt when the config changes; null when unset. */
  currentClient(): MemoryClient | null {
    const url = this.deps.getMemoryUrl();
    if (!url) return null;
    if (url !== this.clientUrl) {
      this.client = new MemoryClient(url);
      this.clientUrl = url;
    }
    return this.client;
  }

  requireClient(): MemoryClient {
    const client = this.currentClient();
    if (!client) {
      throw new MemoryUnavailableError(
        "Memory is not configured on this host (memory.url in config.json)",
      );
    }
    return client;
  }

  /** Queue an agent's turns (unchanged ones are dropped by the outbox). */
  pushTurns(source: Omit<TurnSource, "host">, chunks: readonly ExtractedChunk[]): void {
    if (!this.outbox || !this.deps.getMemoryUrl()) return;
    this.outbox.enqueueItems(buildTurnItems({ ...source, host: this.deps.hostLabel() }, chunks));
  }

  pushRunRecord(record: MissionControlRunRecord): void {
    if (!this.outbox || !this.deps.getMemoryUrl()) return;
    const parts = [
      splitAgentModeBlock(record.brief ?? "").body.trim(),
      ...record.reports.map(
        (r) => `${r.reportKind ?? r.kind}: ${r.headline}${r.detail ? ` ${r.detail}` : ""}`,
      ),
      ...(record.verdict ? [`verdict: ${record.verdict.summary}`] : []),
      ...record.proofs.map((p) =>
        `proof: ${p.label ?? p.kind} ${p.url ?? p.path ?? ""} ${p.excerpt ?? ""}`.trim(),
      ),
    ];
    this.outbox.enqueueItems([
      {
        id: `run:${record.agentId}:${record.runEpoch}`,
        kind: "run",
        title: record.agentTitle,
        text: parts.filter(Boolean).join("\n"),
        host: record.hostAlias,
        agent_id: record.agentId,
        project: record.projectName,
        ts: Date.parse(record.endedAt) || null,
        meta: { agent_name: record.agentName, outcome: record.outcome },
      },
    ]);
  }

  /** A learning reported with report_status: queued, so the report never waits on memory. */
  queueNote(note: MemoryNoteInput): boolean {
    if (!this.outbox || !this.deps.getMemoryUrl()) return false;
    this.outbox.enqueueNote(note);
    return true;
  }

  /** Write a note now; when memory is unreachable it is queued and delivered later. */
  async writeNote(note: MemoryNoteInput): Promise<{ queued: boolean; result?: unknown }> {
    try {
      return { queued: false, result: await this.requireClient().writeNote(note) };
    } catch (error) {
      if (error instanceof MemoryUnavailableError && this.queueNote(note)) {
        this.deps.logger.warn({ err: error }, "memory.note_queued");
        return { queued: true };
      }
      throw error;
    }
  }

  pendingWrites(): number {
    return this.outbox?.pendingCount() ?? 0;
  }

  /** True until this host's whole history has been offered once (see markInitialBackfill). */
  needsInitialBackfill(): boolean {
    return Boolean(
      this.outbox && this.deps.getMemoryUrl() && !this.outbox.getState("initial_backfill"),
    );
  }

  markInitialBackfill(): void {
    this.outbox?.setState("initial_backfill", new Date().toISOString());
  }
}
