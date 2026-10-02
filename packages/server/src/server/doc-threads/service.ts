import type { Logger } from "pino";
import type {
  DocThread,
  DocThreadAnchor,
  DocThreadMessage,
} from "@getpaseo/protocol/doc-threads/types";
import type { SessionInboundMessage } from "../messages.js";
import { DocThreadStore, newDocThreadId } from "./store.js";

type RequestFields<T extends SessionInboundMessage["type"]> = Omit<
  Extract<SessionInboundMessage, { type: T }>,
  "type" | "requestId"
>;

export type ListDocThreadsInput = RequestFields<"doc_threads.list.request">;
export type CreateDocThreadInput = RequestFields<"doc_threads.create.request">;
export type ReplyDocThreadInput = RequestFields<"doc_threads.reply.request">;
export type ResolveDocThreadInput = RequestFields<"doc_threads.resolve.request">;
export type SendAllDocThreadsInput = RequestFields<"doc_threads.send_all.request">;

export type DocThreadsErrorCode = "not_found" | "invalid";

export class DocThreadsError extends Error {
  constructor(
    readonly code: DocThreadsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocThreadsError";
  }
}

/** A thread plus where it lives, for prompt delivery and push fan-out. */
export interface DocThreadRecord extends DocThread {
  workspaceId: string;
  cwd: string;
}

export interface DocThreadChangedEvent {
  agentId: string;
  path?: string;
  threadIds: string[];
}

export interface DocThreadsAgentLookup {
  /** Null when this host does not own the agent. */
  getAgentWorkspace(agentId: string): Promise<{ workspaceId: string; cwd: string } | null>;
}

export interface DocThreadsServiceOptions {
  store: DocThreadStore;
  agents: DocThreadsAgentLookup;
  now?: () => string;
  logger: Logger;
}

/**
 * Business rules of doc threads over DocThreadStore. Every mutation bumps
 * updated_at and notifies onChange after commit; the session layer fans that
 * out as `doc_threads.changed`.
 */
export class DocThreadsService {
  private readonly store: DocThreadStore;
  private readonly agents: DocThreadsAgentLookup;
  private readonly now: () => string;
  private readonly logger: Logger;
  private readonly changeListeners = new Set<(event: DocThreadChangedEvent) => void>();

  constructor(options: DocThreadsServiceOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.now = options.now ?? (() => new Date().toISOString());
    this.logger = options.logger.child({ module: "doc-threads" });
  }

  onChange(listener: (event: DocThreadChangedEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emit(event: DocThreadChangedEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({ err: error }, "Doc threads change listener failed");
      }
    }
  }

  async listThreads(input: ListDocThreadsInput): Promise<DocThread[]> {
    const owned = await this.requireOwnedAgent(input.agentId);
    return this.store
      .listThreadRecords({
        agentId: input.agentId,
        workspaceId: owned.workspaceId,
        ...(input.path ? { path: normalizeThreadPath(input.path) } : {}),
      })
      .map(toWire);
  }

  async createThread(input: CreateDocThreadInput): Promise<DocThread> {
    const owned = await this.requireOwnedAgent(input.agentId);
    const now = this.now();
    const id = newDocThreadId();
    const anchor: DocThreadAnchor = {
      quote: input.anchor.quote,
      startLine: input.anchor.startLine,
      endLine: input.anchor.endLine,
      ...(input.anchor.before !== undefined ? { before: input.anchor.before } : {}),
      ...(input.anchor.after !== undefined ? { after: input.anchor.after } : {}),
    };
    const firstMessage: DocThreadMessage = { author: "user", body: input.body, ts: now };
    this.store.insertThread({
      id,
      agentId: input.agentId,
      workspaceId: owned.workspaceId,
      cwd: owned.cwd,
      path: normalizeThreadPath(input.path),
      anchor,
      status: "open",
      createdAt: now,
      updatedAt: now,
      firstMessage,
    });
    const created = this.requireThread(id);
    this.emit({ agentId: created.agentId, path: created.path, threadIds: [created.id] });
    return toWire(created);
  }

  async replyToThread(
    input: ReplyDocThreadInput,
    author: "user" | "agent",
    expectedAgentId?: string,
  ): Promise<DocThread> {
    const record = this.requireThread(input.threadId);
    if (expectedAgentId && record.agentId !== expectedAgentId) {
      throw new DocThreadsError("invalid", `Thread ${input.threadId} belongs to another agent`);
    }
    const message: DocThreadMessage = { author, body: input.body, ts: this.now() };
    this.store.appendMessage({ threadId: record.id, message, updatedAt: message.ts });
    const updated = this.requireThread(input.threadId);
    this.emit({ agentId: updated.agentId, path: updated.path, threadIds: [updated.id] });
    return toWire(updated);
  }

  /** Agent-initiated thread: same as create, but the first message is the agent's. */
  async commentOnFile(input: {
    agentId: string;
    path: string;
    anchor: DocThreadAnchor;
    body: string;
  }): Promise<DocThread> {
    const owned = await this.requireOwnedAgent(input.agentId);
    const now = this.now();
    const id = newDocThreadId();
    this.store.insertThread({
      id,
      agentId: input.agentId,
      workspaceId: owned.workspaceId,
      cwd: owned.cwd,
      path: normalizeThreadPath(input.path),
      anchor: input.anchor,
      status: "open",
      createdAt: now,
      updatedAt: now,
      firstMessage: { author: "agent", body: input.body, ts: now },
    });
    const created = this.requireThread(id);
    this.emit({ agentId: created.agentId, path: created.path, threadIds: [created.id] });
    return toWire(created);
  }

  async resolveThread(input: ResolveDocThreadInput): Promise<DocThread> {
    const record = this.requireThread(input.threadId);
    const now = this.now();
    this.store.setStatus(record.id, input.resolved ? "resolved" : "open", now);
    const updated = this.requireThread(input.threadId);
    this.emit({ agentId: updated.agentId, path: updated.path, threadIds: [updated.id] });
    return toWire(updated);
  }

  /**
   * Threads for one send_all delivery, in request order. All must be open,
   * owned by the agent, and in the request workspace.
   */
  async threadsForSend(input: SendAllDocThreadsInput): Promise<DocThreadRecord[]> {
    const owned = await this.requireOwnedAgent(input.agentId);
    const seen = new Set<string>();
    const threads: DocThreadRecord[] = [];
    for (const threadId of input.threadIds) {
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      const record = this.requireThread(threadId);
      if (record.agentId !== input.agentId) {
        throw new DocThreadsError("invalid", `Thread ${threadId} belongs to another agent`);
      }
      if (record.workspaceId !== owned.workspaceId) {
        throw new DocThreadsError("invalid", `Thread ${threadId} is in another workspace`);
      }
      if (record.status !== "open") {
        throw new DocThreadsError("invalid", `Thread ${threadId} is resolved`);
      }
      threads.push(record);
    }
    if (threads.length === 0) {
      throw new DocThreadsError("invalid", "No threads to send");
    }
    return threads;
  }

  markSent(threadIds: string[], agentId: string): void {
    this.emit({ agentId, threadIds });
  }

  private async requireOwnedAgent(agentId: string): Promise<{ workspaceId: string; cwd: string }> {
    const owned = await this.agents.getAgentWorkspace(agentId);
    if (!owned) {
      throw new DocThreadsError("not_found", `Agent not found on this host: ${agentId}`);
    }
    return owned;
  }

  private requireThread(threadId: string): DocThreadRecord {
    const stored = this.store.getThreadRecord(threadId);
    if (!stored) {
      throw new DocThreadsError("not_found", `Thread not found: ${threadId}`);
    }
    return stored;
  }
}

function toWire(record: DocThreadRecord): DocThread {
  const { workspaceId: _workspaceId, cwd: _cwd, ...wire } = record;
  return wire;
}

function normalizeThreadPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed || trimmed === "." || trimmed.startsWith("/") || trimmed.includes("..")) {
    throw new DocThreadsError("invalid", `Invalid thread path: ${raw}`);
  }
  return trimmed;
}
