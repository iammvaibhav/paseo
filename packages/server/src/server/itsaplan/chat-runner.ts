import type { Logger } from "pino";
import type { MissionControlEvent } from "@getpaseo/protocol/mission-control/types";
import {
  ItsaplanApiError,
  ItsaplanClient,
  type ItsaplanAgUiEvent,
  type ItsaplanClaimedAgentRun,
  type ItsaplanClaimedChatMessage,
} from "./client.js";
import type {
  ItsaplanCentralConfig,
  ItsaplanProjectMapping,
  ItsaplanProjectStore,
} from "./projects.js";

/**
 * ADR 0002 chat-runner: the Paseo daemon acts as the `@itsaplan/runner` for
 * every project's "Commander" external agent (projects.ts
 * ensureCommanderAiAgent) — one claim loop per project, long-polling
 * itsaplan's chat queue and relaying each claimed message to the SAME
 * mailbox real chat/voice use (deliverCommanderInstruction,
 * mission-control/service.ts "M8 mailbox"), so an itsaplan chat message gets
 * exactly the same busy-steer / idle-snapshot-then-steer treatment a Paseo
 * app chat message would — never a second, competing delivery path into the
 * Commander's turn.
 *
 * Reply capture: deliverCommanderInstruction hands back an instruction id
 * (the M8 ledger row it opened) but not the eventual answer text — the
 * Commander's turn completes asynchronously, well after the delivery call
 * returns, and possibly after being folded into other in-flight work. The
 * chosen mechanism is MissionControlService.subscribeEvents (added
 * alongside this module — a general fan-out over every emitted feed event,
 * mirroring the existing subscribeSelfReports which is scoped to
 * source:"self"): the ledger closes via a card carrying `respondsTo` equal
 * to the instruction id — either a citing post_answer/clarify/proposal tool
 * call, or (when the Commander only answered in prose) the daemon's own
 * synthesized generic answer card (service.ts synthesizeCommanderAnswerCards)
 * — and that card's `answer.body`/`clarification.question`/`proposal.message`
 * IS the Commander's reply text. This reuses the exact ledger-closing
 * semantics the Paseo app's own chat already depends on instead of
 * re-deriving reply-completion from the raw agent stream (turn_started /
 * assistant deltas / turn_completed), which would have to reimplement
 * CommanderInstructionTracker's ack-drop and multi-instruction bookkeeping a
 * second time to get the same answer.
 *
 * Concurrency: the mailbox is safe for concurrent chat deliveries from
 * multiple itsaplan projects (and Paseo's own chat/voice) hitting the same
 * Commander at once — deliverCommanderInstruction already serializes against
 * an in-flight turn (steer) vs. an idle one (fresh snapshot turn, then
 * steer); this module adds no locking of its own.
 *
 * Mentions drain through a SEPARATE queue (`POST /agent-runs/claim`,
 * apps/api/src/modules/agents/runner/index.ts) — ticket `resultBody
 * {status,output,error}` vs. chat's AG-UI event stream. This module runs
 * one claim loop per queue per project. projects.ts creates the Commander
 * agent with `triggerOnMention: true` so @commander comments enqueue runs
 * this drain claims.
 */
export interface ItsaplanChatRunnerMissionControl {
  deliverCommanderInstruction(input: {
    text: string;
    source: "chat";
    messageId?: string;
  }): Promise<
    { ok: true; instructionId: string; deliveredAs: "run" | "steer" } | { ok: false; error: string }
  >;
  subscribeEvents(listener: (event: MissionControlEvent) => void): () => void;
}

export interface ItsaplanChatRunnerOptions {
  logger: Logger;
  projectStore: ItsaplanProjectStore;
  getConfig: () => ItsaplanCentralConfig | null;
  missionControl: ItsaplanChatRunnerMissionControl;
  /** How often the running claim-loop set is reconciled against the project
   * store — picks up a project whose Commander agent was just backfilled,
   * and stops the loop for a project the store no longer has. Default 30s. */
  supervisorIntervalMs?: number;
  /** How often a heartbeat is sent while a reply is pending. Default 20s;
   * a test seam to observe heartbeats without waiting for the real cadence. */
  heartbeatIntervalMs?: number;
  /** Ceiling on how long one claim waits for the Commander's reply before
   * being reported unreachable. Default 10 minutes; a test seam. */
  replyWaitTimeoutMs?: number;
}

// itsaplan's default claim wait is 25s (AGENT_CHAT_CLAIM_WAIT_MS,
// apps/api/src/modules/agents/chat/service.ts) — claimChatMessage already
// carries its own generous client-side timeout for that; this is the FIRST
// backoff before retrying a claim call that failed outright (network/5xx).
const CLAIM_RETRY_BACKOFF_MS = 2_000;
// Ceiling for the exponential backoff on a failing claim. A flat 2s retry
// through a long itsaplan outage is what turned one rejected credential into
// ~380 MB of identical log lines.
const MAX_CLAIM_RETRY_BACKOFF_MS = 60_000;
// /agent-runs/claim does NOT long-poll (unlike /agent-chats/claim). An empty
// queue must sleep or two mapped projects × mention loops burn the API-key
// rate limit (100/s) and starve webhook deliveries.
const EMPTY_RUN_CLAIM_BACKOFF_MS = 2_000;
// Comfortably inside itsaplan's default 300s lease (AGENT_CHAT_LEASE_SECONDS)
// so a slow Commander turn never loses the claim mid-answer.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
// Ceiling on how long one claim is held open waiting for the Commander's
// turn to complete before the chat-runner reports it unreachable — bounded
// so a wedged Commander can never hang a claim past a sane multiple of its
// own lease.
const DEFAULT_REPLY_WAIT_TIMEOUT_MS = 10 * 60_000;
// itsaplan's own AG-UI text-delta cap (chat/model.ts DELTA_LIMIT).
const AG_UI_TEXT_DELTA_LIMIT = 12_000;
// itsaplan's own RUN_ERROR message cap (chat/model.ts RunErrorEvent).
const AG_UI_ERROR_MESSAGE_LIMIT = 2_000;
const DEFAULT_SUPERVISOR_INTERVAL_MS = 30_000;

type ChatRunnerMapping = ItsaplanProjectMapping & {
  commanderAgentId: number;
  commanderApiKey: string;
};

type ReplyOutcome = { kind: "text"; text: string } | { kind: "canceled" } | { kind: "timeout" };

function hasCommanderCredentials(mapping: ItsaplanProjectMapping): mapping is ChatRunnerMapping {
  return mapping.commanderAgentId !== undefined && mapping.commanderApiKey !== undefined;
}

/**
 * True when a claim call can never succeed by being retried: itsaplan
 * rejected the credential (401/403 — the stored one-time key was rotated, or
 * its agent went away with a deleted project) or the queue itself is gone
 * (404). Live incident: an itsaplan project was deleted, its agent key
 * started answering 403 "Only an agent key can drain an agent feed", and both
 * claim loops retried it every 2s for days.
 */
function isPermanentClaimFailure(error: unknown): error is ItsaplanApiError {
  return (
    error instanceof ItsaplanApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * The Commander's reply text for one delivered instruction, read off the
 * feed card that closed its M8 ledger row (see module doc). Null when this
 * event is not that card.
 */
function extractCommanderReplyText(
  event: MissionControlEvent,
  instructionId: string,
): string | null {
  if (event.kind === "answer" && event.answer?.respondsTo === instructionId) {
    const body = event.answer.body?.trim();
    return body && body.length > 0 ? body : event.answer.headline;
  }
  if (event.kind === "clarification" && event.clarification?.respondsTo === instructionId) {
    const options = event.clarification.options;
    const optionsSuffix = options.length > 0 ? ` Options: ${options.join(", ")}` : "";
    return `${event.clarification.question}${optionsSuffix}`;
  }
  if (event.kind === "proposal" && event.proposal?.respondsTo === instructionId) {
    return `Action taken: ${event.proposal.spawnPlan?.summary ?? event.proposal.message}`;
  }
  return null;
}

/**
 * ADR 0002 chat-runner: one long-poll claim loop per project with a
 * Commander agent, relaying itsaplan chat into the Commander's mailbox and
 * itsaplan's synthesized answer card back out. Fully inert when central
 * config `itsaplan` is absent — the supervisor sweep stops every running
 * loop and starts none while `getConfig()` returns null.
 */
export class ItsaplanChatRunner {
  private readonly logger: Logger;
  private readonly projectStore: ItsaplanProjectStore;
  private readonly getConfig: () => ItsaplanCentralConfig | null;
  private readonly missionControl: ItsaplanChatRunnerMissionControl;
  private readonly supervisorIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly replyWaitTimeoutMs: number;

  private readonly loops = new Map<number, { stop: () => void }>();
  private supervisorTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(options: ItsaplanChatRunnerOptions) {
    this.logger = options.logger.child({ module: "itsaplan", component: "chat-runner" });
    this.projectStore = options.projectStore;
    this.getConfig = options.getConfig;
    this.missionControl = options.missionControl;
    this.supervisorIntervalMs = options.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.replyWaitTimeoutMs = options.replyWaitTimeoutMs ?? DEFAULT_REPLY_WAIT_TIMEOUT_MS;
  }

  start(): void {
    if (this.supervisorTimer) {
      return;
    }
    this.stopped = false;
    this.reconcileLoops();
    this.supervisorTimer = setInterval(() => this.reconcileLoops(), this.supervisorIntervalMs);
    this.supervisorTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.supervisorTimer) {
      clearInterval(this.supervisorTimer);
      this.supervisorTimer = null;
    }
    for (const loop of this.loops.values()) {
      loop.stop();
    }
    this.loops.clear();
  }

  /** Starts a loop for every mapping with Commander credentials that has
   * none yet, and stops loops for agent ids no longer present (config
   * removed, or the mapping vanished). Config-gated: absent config tears
   * every loop down. */
  private reconcileLoops(): void {
    if (!this.getConfig()) {
      for (const loop of this.loops.values()) {
        loop.stop();
      }
      this.loops.clear();
      return;
    }
    const liveAgentIds = new Set<number>();
    for (const mapping of this.projectStore.list()) {
      if (!hasCommanderCredentials(mapping)) {
        continue;
      }
      liveAgentIds.add(mapping.commanderAgentId);
      if (!this.loops.has(mapping.commanderAgentId)) {
        this.loops.set(mapping.commanderAgentId, this.startLoop(mapping));
      }
    }
    for (const [agentId, loop] of this.loops) {
      if (!liveAgentIds.has(agentId)) {
        loop.stop();
        this.loops.delete(agentId);
      }
    }
  }

  private startLoop(mapping: ChatRunnerMapping): { stop: () => void } {
    const loop = { stopped: false };
    // Failure streak is shared by both of this mapping's claim loops: they
    // authenticate with the same credential against the same instance, so a
    // rejected key or a down itsaplan fails them together.
    const failures = { streak: 0 };
    // Loop 1: chat messages long-poll
    void (async () => {
      while (!loop.stopped && !this.stopped) {
        const config = this.getConfig();
        if (!config) {
          // The next supervisor sweep tears this loop entry down.
          return;
        }
        const client = new ItsaplanClient({
          baseUrl: config.baseUrl,
          apiKey: mapping.commanderApiKey,
        });
        let claimed: ItsaplanClaimedChatMessage | null;
        try {
          claimed = await client.claimChatMessage();
        } catch (error) {
          if (
            !(await this.handleClaimFailure({
              mapping,
              loop,
              failures,
              error,
              transientMessage: "itsaplan.chat_runner.claim_failed",
            }))
          ) {
            return;
          }
          continue;
        }
        failures.streak = 0;
        if (!claimed) {
          continue;
        }
        await this.handleClaimedMessage(client, claimed, mapping);
      }
    })();
    // Loop 2: agent runs (@mention drain)
    void (async () => {
      while (!loop.stopped && !this.stopped) {
        const config = this.getConfig();
        if (!config) {
          return;
        }
        const client = new ItsaplanClient({
          baseUrl: config.baseUrl,
          apiKey: mapping.commanderApiKey,
        });
        let claimedRun: ItsaplanClaimedAgentRun | null;
        try {
          claimedRun = await client.claimAgentRun();
        } catch (error) {
          if (
            !(await this.handleClaimFailure({
              mapping,
              loop,
              failures,
              error,
              transientMessage: "itsaplan.chat_runner.run_claim_failed",
            }))
          ) {
            return;
          }
          continue;
        }
        failures.streak = 0;
        if (!claimedRun) {
          await delay(EMPTY_RUN_CLAIM_BACKOFF_MS);
          continue;
        }
        await this.handleClaimedRun(client, claimedRun, mapping);
      }
    })();
    return {
      stop: () => {
        loop.stopped = true;
      },
    };
  }

  /**
   * A claim call threw. Returns false when the caller's loop must exit.
   *
   * A rejected credential or a vanished queue can never recover by being
   * retried, so the mapping's key is forgotten (the next project sync
   * re-mints it) and both loops for it stop — retrying a permanent failure
   * on a flat 2s cadence is what filled a daemon log with one deleted
   * project's 403s. Anything else is transient: back off exponentially to
   * MAX_CLAIM_RETRY_BACKOFF_MS and log only the first failure of a streak,
   * so an itsaplan outage costs a few lines instead of one per retry.
   */
  private async handleClaimFailure(input: {
    mapping: ChatRunnerMapping;
    loop: { stopped: boolean };
    failures: { streak: number };
    error: unknown;
    transientMessage: string;
  }): Promise<boolean> {
    const { mapping, loop, failures, error } = input;
    if (isPermanentClaimFailure(error)) {
      loop.stopped = true;
      this.loops.delete(mapping.commanderAgentId);
      this.logger.error(
        {
          err: error,
          status: error.status,
          itsaplanProjectKey: mapping.itsaplanProjectKey,
          commanderAgentId: mapping.commanderAgentId,
        },
        "itsaplan.chat_runner.credential_rejected",
      );
      await this.projectStore.clearCommanderApiKey(mapping.paseoProjectKey);
      return false;
    }
    failures.streak += 1;
    if (failures.streak === 1) {
      this.logger.warn(
        { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey },
        input.transientMessage,
      );
    }
    await delay(
      Math.min(CLAIM_RETRY_BACKOFF_MS * 2 ** (failures.streak - 1), MAX_CLAIM_RETRY_BACKOFF_MS),
    );
    return true;
  }

  private async handleClaimedMessage(
    client: ItsaplanClient,
    claimed: ItsaplanClaimedChatMessage,
    mapping: ChatRunnerMapping,
  ): Promise<void> {
    try {
      await client.postChatEvents(claimed.id, [{ type: "RUN_STARTED" }]);
    } catch (error) {
      this.logger.warn(
        { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey, messageId: claimed.id },
        "itsaplan.chat_runner.run_started_report_failed",
      );
    }
    try {
      const text = [claimed.systemPrompt, claimed.prompt]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
      const delivery = await this.missionControl.deliverCommanderInstruction({
        text,
        source: "chat",
        messageId: `itsaplan:${mapping.itsaplanProjectKey}:${claimed.id}`,
      });
      if (!delivery.ok) {
        await this.reportUnreachable(
          client,
          claimed.id,
          `Commander unreachable: ${delivery.error}`,
        );
        return;
      }
      const outcome = await this.awaitCommanderReply(delivery.instructionId, () =>
        client.heartbeatChatMessage(claimed.id),
      );
      if (outcome.kind === "canceled") {
        // itsaplan already closed the answer terminally (a chat-side stop);
        // finishMessage on an already-terminal row 404s, so there is
        // nothing left to report.
        return;
      }
      if (outcome.kind === "timeout") {
        await this.reportUnreachable(
          client,
          claimed.id,
          "Commander was unreachable: no reply within the reply window",
        );
        return;
      }
      await this.sendReply(client, claimed.id, outcome.text);
    } catch (error) {
      this.logger.error(
        { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey, messageId: claimed.id },
        "itsaplan.chat_runner.claim_handling_failed",
      );
      await this.reportUnreachable(
        client,
        claimed.id,
        `Commander unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Waits for the Commander's reply card while sending heartbeats to keep
   * the claim leased. Resolves "canceled" the moment itsaplan reports the
   * chat-side stop on a heartbeat ack, "timeout" past REPLY_WAIT_TIMEOUT_MS,
   * or "text" the moment the instruction's ledger-closing card is observed. */
  private async handleClaimedRun(
    client: ItsaplanClient,
    claimed: ItsaplanClaimedAgentRun,
    mapping: ChatRunnerMapping,
  ): Promise<void> {
    try {
      const parts: string[] = [];
      if (claimed.issueIdentifier) {
        const config = this.getConfig();
        const seq = claimed.issueIdentifier.includes("-")
          ? claimed.issueIdentifier.split("-")[1]
          : claimed.issueIdentifier;
        const url = config
          ? `${config.baseUrl.replace(/\/+$/, "")}/project/${encodeURIComponent(mapping.itsaplanProjectKey)}/issues/${encodeURIComponent(seq ?? "")}`
          : undefined;
        parts.push(`Issue: ${claimed.issueIdentifier}${url ? ` (${url})` : ""}`);
      }
      if (claimed.systemPrompt.trim().length > 0) {
        parts.push(claimed.systemPrompt);
      }
      parts.push(claimed.prompt);
      const text = parts.join("\n\n");

      const delivery = await this.missionControl.deliverCommanderInstruction({
        text,
        source: "chat",
        messageId: `itsaplan-run:${mapping.itsaplanProjectKey}:${claimed.id}`,
      });
      if (!delivery.ok) {
        await this.reportRunFailed(client, claimed.id, `Commander unreachable: ${delivery.error}`);
        return;
      }
      const outcome = await this.awaitCommanderReply(delivery.instructionId, async () => {
        await client.heartbeatAgentRun(claimed.id);
        return { canceled: false };
      });
      if (outcome.kind === "canceled") {
        // itsaplan already closed/canceled the run; stop, don't finish
        return;
      }
      if (outcome.kind === "timeout") {
        await this.reportRunFailed(
          client,
          claimed.id,
          "Commander was unreachable: no reply within the reply window",
        );
        return;
      }
      await client.postAgentRunResult(claimed.id, {
        status: "success",
        output: outcome.text,
      });
      if (claimed.issueId) {
        try {
          await client.postComment(claimed.issueId, outcome.text);
        } catch (error) {
          this.logger.warn(
            { err: error, issueId: claimed.issueId, runId: claimed.id },
            "itsaplan.chat_runner.run_comment_failed",
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, itsaplanProjectKey: mapping.itsaplanProjectKey, runId: claimed.id },
        "itsaplan.chat_runner.run_handling_failed",
      );
      await this.reportRunFailed(
        client,
        claimed.id,
        `Commander unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async reportRunFailed(
    client: ItsaplanClient,
    runId: number,
    reason: string,
  ): Promise<void> {
    try {
      await client.postAgentRunResult(runId, {
        status: "failed",
        error: reason.slice(0, 500),
      });
    } catch (error) {
      this.logger.warn({ err: error, runId }, "itsaplan.chat_runner.run_result_report_failed");
    }
  }

  /** Waits for the Commander's reply card while sending heartbeats to keep
   * the claim leased. Resolves "canceled" the moment itsaplan reports the
   * stop or 404 on a heartbeat, "timeout" past REPLY_WAIT_TIMEOUT_MS,
   * or "text" the moment the instruction's ledger-closing card is observed. */
  private awaitCommanderReply(
    instructionId: string,
    heartbeatFn: () => Promise<{ canceled?: boolean }>,
  ): Promise<ReplyOutcome> {
    const { promise, resolve } = Promise.withResolvers<ReplyOutcome>();
    let settled = false;
    const settle = (outcome: ReplyOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = this.missionControl.subscribeEvents((event) => {
      const text = extractCommanderReplyText(event, instructionId);
      if (text !== null) {
        settle({ kind: "text", text });
      }
    });
    const heartbeat = setInterval(() => {
      heartbeatFn()
        .then((ack) => {
          if (ack.canceled) {
            settle({ kind: "canceled" });
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (error instanceof ItsaplanApiError && error.status === 404) {
            settle({ kind: "canceled" });
            return;
          }
          this.logger.warn({ err: error }, "itsaplan.chat_runner.heartbeat_failed");
        });
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();
    const deadline = setTimeout(() => settle({ kind: "timeout" }), this.replyWaitTimeoutMs);
    deadline.unref?.();
    return promise;
  }

  private async sendReply(client: ItsaplanClient, messageId: number, text: string): Promise<void> {
    const wireMessageId = `answer-${messageId}`;
    const events: ItsaplanAgUiEvent[] = [
      { type: "TEXT_MESSAGE_START", messageId: wireMessageId, role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: wireMessageId,
        delta: text.slice(0, AG_UI_TEXT_DELTA_LIMIT),
      },
      { type: "TEXT_MESSAGE_END", messageId: wireMessageId },
      { type: "RUN_FINISHED" },
    ];
    try {
      await client.postChatEvents(messageId, events);
      await client.postChatResult(messageId, { status: "success" });
    } catch (error) {
      this.logger.warn({ err: error, messageId }, "itsaplan.chat_runner.reply_report_failed");
    }
  }

  /** Never leaves a claim hanging past its lease: reports a failed result so
   * itsaplan's own retry/expiry (agentChatConfig.maxAttempts) takes over
   * instead of the answer sitting claimed until the lease times out. */
  private async reportUnreachable(
    client: ItsaplanClient,
    messageId: number,
    reason: string,
  ): Promise<void> {
    const trimmed = reason.slice(0, AG_UI_ERROR_MESSAGE_LIMIT);
    try {
      await client.postChatEvents(messageId, [{ type: "RUN_ERROR", message: trimmed }]);
    } catch (error) {
      this.logger.warn({ err: error, messageId }, "itsaplan.chat_runner.run_error_report_failed");
    }
    try {
      await client.postChatResult(messageId, { status: "failed", error: trimmed });
    } catch (error) {
      this.logger.warn({ err: error, messageId }, "itsaplan.chat_runner.result_report_failed");
    }
  }
}
