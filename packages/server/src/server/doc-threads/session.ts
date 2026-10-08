import type pino from "pino";
import type { DocThreadRecord } from "./service.js";
import { DocThreadsError, type DocThreadsService } from "./service.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { buildAgentPrompt } from "../agent/prompt-attachments.js";
import { startAgentRun } from "../agent/agent-prompt.js";

type DocThreadsRequest = Extract<SessionInboundMessage, { type: `doc_threads.${string}.request` }>;
interface Attempt<T> {
  value: T;
  error: string | null;
}

export interface DocThreadsDelivery {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: pino.Logger;
}

export interface DocThreadsHost {
  service: DocThreadsService | null;
  delivery: DocThreadsDelivery;
}

export function isServingDocThreads(host: DocThreadsHost | null): boolean {
  return host !== null && host.service !== null;
}

function isRequest(message: SessionInboundMessage): message is DocThreadsRequest {
  return message.type.startsWith("doc_threads.") && message.type.endsWith(".request");
}

function formatDocThreadPrompt(threads: DocThreadRecord[]): string {
  const sections = threads.map((thread, index) => {
    const history = thread.messages
      .map((message) => `[${message.author} @ ${message.ts}]\n${message.body}`)
      .join("\n\n");
    return [
      `## Thread ${index + 1}: ${thread.path}`,
      `Thread ID: ${thread.id}`,
      `Anchor (lines ${thread.anchor.startLine}-${thread.anchor.endLine}):`,
      `> ${thread.anchor.quote.replace(/\n/g, "\n> ")}`,
      thread.anchor.before ? `Before:\n${thread.anchor.before}` : "",
      thread.anchor.after ? `After:\n${thread.anchor.after}` : "",
      "Thread history:",
      history,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "The user left comments on files you are working with. Reply in each thread using the reply_to_thread MCP tool.",
    "",
    ...sections,
  ].join("\n\n");
}

export { formatDocThreadPrompt };

// send_all waits for the agent to go idle, then delivers. The bound stays
// well under the 60 s client RPC timeout so the client never times out while
// the daemon still delivers (a retry would then deliver twice).
export const SEND_ALL_IDLE_WAIT_MS = 25_000;
export const SEND_ALL_CLIENT_TIMEOUT_MS = 60_000;

export interface DocThreadsSessionOptions {
  emit(message: SessionOutboundMessage): void;
  host: DocThreadsHost | null;
  logger: pino.Logger;
}

export class DocThreadsSession {
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly host: DocThreadsHost | null;
  private readonly logger: pino.Logger;
  private readonly sendAllTails = new Map<string, Promise<void>>();
  private readonly recentlySent = new Map<string, number>();
  private static readonly SEND_DEDUPE_WINDOW_MS = 60_000;
  private static readonly SEND_DEDUPE_MAX_KEYS = 500;

  constructor(options: DocThreadsSessionOptions) {
    this.emit = options.emit;
    this.host = options.host;
    this.logger = options.logger;
  }

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!isRequest(message)) return undefined;
    switch (message.type) {
      case "doc_threads.list.request":
        return this.handleList(message);
      case "doc_threads.create.request":
        return this.handleCreate(message);
      case "doc_threads.reply.request":
        return this.handleReply(message);
      case "doc_threads.resolve.request":
        return this.handleResolve(message);
      case "doc_threads.send_all.request":
        return this.handleSendAll(message);
    }
  }

  private serving(): DocThreadsService {
    if (!this.host?.service)
      throw new DocThreadsError("invalid", "Doc threads are unavailable on this host");
    return this.host.service;
  }

  private async attempt<T>(work: (service: DocThreadsService) => Promise<T>): Promise<Attempt<T>> {
    try {
      return { value: await work(this.serving()), error: null };
    } catch (error) {
      if (!(error instanceof DocThreadsError))
        this.logger.error({ err: error }, "Doc threads request failed");
      return {
        value: undefined as T,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async handleList(
    request: Extract<DocThreadsRequest, { type: "doc_threads.list.request" }>,
  ) {
    const result = await this.attempt((service) => service.listThreads(request));
    this.emit({
      type: "doc_threads.list.response",
      payload: { requestId: request.requestId, error: result.error, threads: result.value ?? [] },
    });
  }

  private async handleCreate(
    request: Extract<DocThreadsRequest, { type: "doc_threads.create.request" }>,
  ) {
    const result = await this.attempt((service) => service.createThread(request));
    this.emit({
      type: "doc_threads.create.response",
      payload: { requestId: request.requestId, error: result.error, thread: result.value ?? null },
    });
  }

  private async handleReply(
    request: Extract<DocThreadsRequest, { type: "doc_threads.reply.request" }>,
  ) {
    const result = await this.attempt((service) => service.replyToThread(request, "user"));
    this.emit({
      type: "doc_threads.reply.response",
      payload: { requestId: request.requestId, error: result.error, thread: result.value ?? null },
    });
  }

  private async handleResolve(
    request: Extract<DocThreadsRequest, { type: "doc_threads.resolve.request" }>,
  ) {
    const result = await this.attempt((service) => service.resolveThread(request));
    this.emit({
      type: "doc_threads.resolve.response",
      payload: { requestId: request.requestId, error: result.error, thread: result.value ?? null },
    });
  }

  private async handleSendAll(
    request: Extract<DocThreadsRequest, { type: "doc_threads.send_all.request" }>,
  ) {
    const agentKey = request.agentId;
    const prior = this.sendAllTails.get(agentKey) ?? Promise.resolve();
    const work: Promise<void> = prior
      .catch(() => undefined)
      .then(async () => {
        const result = await this.attempt(async (service) => {
          if (!this.host)
            throw new DocThreadsError("invalid", "Doc threads are unavailable on this host");
          const threads = await service.threadsForSend(request);
          const ids = threads.map((thread) => thread.id).sort();
          const dedupeKey = `${agentKey}:${ids.join(",")}`;
          const lastSent = this.recentlySent.get(dedupeKey);
          if (
            lastSent !== undefined &&
            Date.now() - lastSent < DocThreadsSession.SEND_DEDUPE_WINDOW_MS
          ) {
            return false;
          }
          const prompt = buildAgentPrompt(formatDocThreadPrompt(threads));
          const deadline = Date.now() + SEND_ALL_IDLE_WAIT_MS;
          while (
            this.host.delivery.agentManager.hasInFlightRun(request.agentId) &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (this.host.delivery.agentManager.hasInFlightRun(request.agentId)) {
            throw new DocThreadsError("invalid", `Agent ${request.agentId} is still busy`);
          }
          await startAgentRun(
            this.host.delivery.agentManager,
            request.agentId,
            prompt,
            this.host.delivery.logger,
            { replaceRunning: false },
          );
          this.recentlySent.set(dedupeKey, Date.now());
          if (this.recentlySent.size > DocThreadsSession.SEND_DEDUPE_MAX_KEYS) {
            const cutoff = Date.now() - DocThreadsSession.SEND_DEDUPE_WINDOW_MS;
            for (const [sentKey, sentAt] of this.recentlySent) {
              if (sentAt < cutoff) this.recentlySent.delete(sentKey);
            }
          }
          service.markSent(ids, request.agentId);
          return true;
        });
        this.emit({
          type: "doc_threads.send_all.response",
          payload: {
            requestId: request.requestId,
            error: result.error,
            sent: result.value === true,
          },
        });
        return undefined;
      });
    this.sendAllTails.set(agentKey, work);
    await work;
    if (this.sendAllTails.get(agentKey) === work) this.sendAllTails.delete(agentKey);
  }
}
