import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { TOOL_ALLOWLIST_CONFIG_OVERLAY } from "./runtime.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

class ManualIdleScheduler implements OmpProviderIdleScheduler {
  private readonly retries: Array<() => void> = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];
  private waitCount = 0;

  waitForRetry(): Promise<void> {
    this.waitCount += 1;
    for (const waiter of this.waiters.splice(0)) {
      if (this.waitCount >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    return new Promise((resolve) => this.retries.push(resolve));
  }

  waitedCount(): number {
    return this.waitCount;
  }

  waitForWaits(count: number): Promise<void> {
    if (this.waitCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  retry(): void {
    const resolve = this.retries.shift();
    if (!resolve) throw new Error("OMP has not requested an idle-state retry");
    resolve();
  }
}

class ManualNoTurnScheduler implements OmpNoTurnScheduler {
  private settleResolve: (() => void) | null = null;
  private aborted = false;

  waitForSettle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settleResolve = resolve;
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          this.settleResolve = null;
          resolve();
        },
        { once: true },
      );
    });
  }

  settle(): void {
    const resolve = this.settleResolve;
    if (!resolve) throw new Error("OMP has not requested a no-turn settle wait");
    this.settleResolve = null;
    resolve();
  }

  wasAborted(): boolean {
    return this.aborted;
  }
}

class ManualUsagePollScheduler implements OmpUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("OMP has not scheduled a context usage poll");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function createToolCatalog(): PaseoToolCatalog {
  return {
    tools: new Map([
      [
        "create_agent",
        {
          name: "create_agent",
          description: "Create a Paseo agent.",
          handler: async () => ({ content: [] }),
        },
      ],
    ]),
    getTool: () => undefined,
    executeTool: async () => ({ content: [] }),
  };
}

describe("OMP agent client and session", () => {
  test("owns launch configuration and registers native host tools", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" }, createToolCatalog());

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "ask",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "always-ask"],
    });
    expect(omp.registeredHostTools()).toEqual([
      [expect.objectContaining({ name: "create_agent" })],
    ]);
    expect(omp.capabilities()).toMatchObject({
      supportsMcpServers: false,
      supportsNativePaseoTools: true,
    });
  });

  test("preserves max as the selected thinking option", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "max" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "max"]));
  });

  test("launches with write approval mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "write",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "write"],
    });
  });

  test("allowlist session launch drops builtins and pins the harness-utility config overlay", async () => {
    const omp = new OmpHarness();
    await omp.start(
      {
        toolAllowlist: ["fleet_list_agents", "fleet_create_agent", "clarify"],
        modeId: "full",
      },
      createToolCatalog(),
    );

    const argv = omp.launchConfiguration().argv;
    expect(argv).toContain("--no-tools");
    expect(argv).not.toContain("--tools");
    // learn/manage_skill (autolearn), checkpoint/rewind (checkpoint) and tts
    // (speechgen) are not builtins — --no-tools cannot remove them; the
    // --config overlay pins their gates off.
    const configIndex = argv.indexOf("--config");
    expect(configIndex).toBeGreaterThan(-1);
    expect(argv[configIndex + 1]).toBe(TOOL_ALLOWLIST_CONFIG_OVERLAY);
  });

  test("passes --thinking when a thinking option is provided", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask", thinkingOptionId: "xhigh" }, createToolCatalog());

    expect(omp.launchConfiguration().argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--thinking",
      "xhigh",
    ]);
  });
  test("updates runtime thinkingOptionId when session thinking level changes at runtime", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.runtime().state.thinkingLevel = "low";

    const initialInfo = await omp.getSession().getRuntimeInfo();
    expect(initialInfo.thinkingOptionId).toBe("low");

    omp.runtime().state.thinkingLevel = "high";
    const updatedInfo = await omp.getSession().getRuntimeInfo();
    expect(updatedInfo.thinkingOptionId).toBe("high");
  });

  test("declares steer out of band and redirects the live turn without canceling it", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("run the long thing");

    const steer = (await omp.commands()).find((command) => command.name === "steer");
    expect(steer?.delivery).toBe("out_of_band");

    await expect(omp.runOutOfBand("/steer print instead")).resolves.toBe(true);

    expect(omp.runtime().steerRequests).toEqual([{ message: "print instead", imageCount: 0 }]);
    expect(omp.wasAborted()).toBe(false);
    expect(omp.canceledTurnCount()).toBe(0);
  });

  test("streams a prompt through completion", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      { type: "assistant_message", text: "hello from OMP", messageId: "omp-assistant-1" },
    ]);
    expect(omp.eventTypes().slice(0, 2)).toEqual(["turn_started", "timeline"]);
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("surfaces omp 17.2+ stream error events as timeline errors", async () => {
    const omp = new OmpHarness();
    await omp.start();

    // omp 17.2+ reports a failing model stream as a message_update whose
    // assistantMessageEvent.type is "error". The daemon used to drop these
    // frames at the schema boundary, leaving a stalled turn with no trail.
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [],
        errorMessage: "upstream stream failed",
        stopReason: "error",
      },
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", content: [] },
      },
    });
    runtime.finishTurn();
    await waitForImmediate();

    expect(omp.timeline()).toContainEqual({
      type: "error",
      message: "upstream stream failed",
    });
  });

  test("streams OMP advisor messages as distinct tool-call blocks", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPromptWithCustomMessage(
      "review this",
      {
        role: "custom",
        content: '<advisory severity="concern">Exercise the failure path.</advisory>',
        customType: "advisor",
        id: "advisor-live-1",
        display: true,
        details: {
          notes: [{ note: "Exercise the failure path.", severity: "concern" }],
        },
      },
      "fixed",
    );

    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "review this", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-advisor:advisor-live-1",
        name: "advisor",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Advisor · 1 note",
          text: "[concern] Exercise the failure path.",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_advisor",
          noteCount: 1,
          blockerCount: 0,
        },
        error: null,
      },
      { type: "assistant_message", text: "fixed", messageId: "omp-assistant-1" },
    ]);
  });

  test("completes a streamed assistant turn when agent_end omits messages", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "hello OMP",
      "empty terminal payload recovered",
    );
    await expect(completion).resolves.toMatchObject({
      finalText: "empty terminal payload recovered",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("starts and stops context usage polling with the active turn", async () => {
    const scheduler = new ManualUsagePollScheduler();
    const omp = new OmpHarness({ usagePollScheduler: scheduler });
    await omp.start();
    omp.runtime().stats = {
      contextUsage: { tokens: 130, contextWindow: 200_000 },
    };
    omp.runtime().state.contextUsage = { tokens: 99, contextWindow: 100_000 };
    await omp.requireStartTurn("keep working");
    expect(scheduler.activePollCount()).toBe(1);
    scheduler.poll();
    await waitForImmediate();
    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = new Error("abort unavailable");
    await expect(omp.interrupt()).rejects.toThrow("abort unavailable");
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = null;
    await omp.interrupt();
    expect(scheduler.activePollCount()).toBe(0);

    await omp.runPrompt("finish normally", "done");
    expect(scheduler.activePollCount()).toBe(0);

    await omp.requireStartTurn("close the session");
    expect(scheduler.activePollCount()).toBe(1);
    await omp.close();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("does not accept a follow-up until OMP reports stable idle", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("first", "first done", [
      { isStreaming: true, isCompacting: false },
      { isStreaming: false, isCompacting: false },
      { isStreaming: false, isCompacting: false },
    ]);
    await expect(omp.runPrompt("follow-up", "follow-up done")).resolves.toMatchObject({
      finalText: "follow-up done",
    });
  });

  test("stays active while OMP remains busy", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);

    expect(omp.completedTurnCount()).toBe(0);
    scheduler.retry();
    await omp.waitForProviderStateChecks(3);
    await scheduler.waitForWaits(2);
    expect(omp.completedTurnCount()).toBe(0);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("stays active when OMP state checks fail", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    omp.failProviderStateChecks(null);
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("fails immediately on overloaded assistant without waiting for provider idle", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptWithTerminalAssistantFailure("continue", {
      role: "assistant",
      content: [],
      errorMessage: "Anthropic stream error (overloaded_error): Overloaded",
      stopReason: "error",
      provider: "anthropic",
      model: "claude-opus-5",
      responseId: "resp-overloaded",
    });

    await expect(completion).rejects.toThrow(/overloaded_error|Overloaded/);
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.failedTurnCount()).toBe(1);
    expect(omp.failedTurnErrors()[0]).toContain("overloaded_error");
    expect(omp.failedTurnErrors()[0]).toContain("stopReason=error");
    // Must not park on provider-idle retries while streaming stays sticky.
    await waitForImmediate();
    expect(scheduler.waitedCount()).toBe(0);
  });

  test("fails immediately on aborted assistant stopReason without waiting for provider idle", async () => {
    const omp = new OmpHarness({ providerIdleScheduler: new ManualIdleScheduler() });
    await omp.start();

    const { completion } = await omp.startPromptWithTerminalAssistantFailure("hello?", {
      role: "assistant",
      content: [],
      errorMessage: "Interrupted by user",
      stopReason: "aborted",
      provider: "anthropic",
      model: "claude-opus-5",
    });

    await expect(completion).rejects.toThrow(/Interrupted by user/);
    expect(omp.failedTurnCount()).toBe(1);
    expect(omp.failedTurnErrors()[0]).toContain("stopReason=aborted");
  });

  test("does not complete on OMP's extension-notice agent_end", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed"),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes the turn when OMP ends a turn it never reported as started", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptWithAgentEndBeforeTurnStart(
      "hello OMP",
      "done anyway",
    );

    await expect(completion).resolves.toMatchObject({ finalText: "done anyway" });
    expect(omp.completedTurnCount()).toBe(1);
    // Nothing to poll for: there was no started turn to wait on.
    expect(scheduler.waitedCount()).toBe(0);
  });

  test("does not emit a second terminal event when an interrupt settles the idle wait", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    await omp.interrupt();
    expect(omp.canceledTurnCount()).toBe(1);

    scheduler.retry();
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.canceledTurnCount()).toBe(1);
  });

  test("omits live custom messages when display is false", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed", false),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "model turn completed",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("renders a live system-notice custom message as a synthetic tool call", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("hello OMP", "done");
    omp
      .runtime()
      .acceptCustomMessage(
        [
          "<system-notice>",
          "Background job DocsSmokeTwo has completed.",
          '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
          "<output>done</output>",
          "</task-result>",
          "</system-notice>",
        ].join("\n"),
      );
    omp.runtime().acceptCustomMessage("plain custom status text");

    expect(omp.timeline().filter((item) => item.type === "tool_call")).toMatchObject([
      { callId: "omp-notice:DocsSmokeTwo", name: "task_notification", status: "completed" },
    ]);
    // Non-notice custom messages still fall through as assistant messages.
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toMatchObject([
      { text: "done" },
      { text: "plain custom status text" },
    ]);
  });

  test("does not complete a queued model turn from OMP's local-only hint", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterFalseLocalOnlyHint("hello OMP", "queued model turn completed"),
    ).resolves.toMatchObject({ finalText: "queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes a local-only prompt when no OMP turn begins", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPromptWithoutTurn("/model")).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("waits for a delayed queued model turn after OMP's local-only result", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterDelayedFalseLocalOnlyResult(
      "hello OMP",
      "delayed queued model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "delayed queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an async local-only result after the settle window", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    expect(prompt.completed()).toBe(false);
    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("cancels an async local-only settle when the OMP session closes", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    await omp.close();

    expect(scheduler.wasAborted()).toBe(true);
    expect(prompt.completed()).toBe(false);
    expect(omp.completedTurnCount()).toBe(0);
  });

  test("preserves a correlated invoked result over a local-only prompt ack", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterCorrelatedTrueResult(
      "hello OMP",
      "correlated model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "correlated model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("keeps clientMessageId on delayed native user echo after false local-only", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterCompletedFalseLocalOnly(
      "hello OMP",
      "delayed autonomous turn",
      "msg-client-local-only",
    );

    expect(completion.completedBeforeNativeEcho).toBe(true);
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      {
        type: "user_message",
        text: "hello OMP",
        clientMessageId: "msg-client-local-only",
      },
      {
        type: "user_message",
        text: "hello OMP",
        messageId: "user-native-delayed",
        clientMessageId: "msg-client-local-only",
      },
    ]);
  });

  test("completes an autonomous OMP turn without a foreground turn ID", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runAutonomousTurn("autonomous turn completed");

    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "autonomous turn completed",
      messageId: "omp-assistant-1",
    });
  });

  test("resumes an OMP session from the warm pool via switch_session", async () => {
    const omp = new OmpHarness();
    await omp.start({ model: "opencode-zen/deepseek-v4-flash-free" });

    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed", model: "opencode-zen/deepseek-v4-flash-free" },
    );

    expect(omp.switchSessionRequests()).toEqual([
      expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
    ]);
    await expect(omp.history()).resolves.toEqual([
      { type: "user_message", text: "continue the audit", messageId: "user-history" },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
  });

  test("cold-starts a resume when the session carries a tool allowlist", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      {
        cwd: "/workspace/resumed",
        modeId: "ask",
        thinkingOptionId: "high",
        toolAllowlist: ["read"],
      },
    );

    expect(omp.latestLaunchHasSessionFlag()).toBe(true);
    expect(omp.switchSessionRequests()).toEqual([]);
    expect(omp.latestLaunchConfiguration()).toEqual({
      cwd: "/workspace/resumed",
      protocolMode: "rpc-ui",
      modeId: "ask",
      session: expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      argv: [
        "omp",
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "always-ask",
        "--thinking",
        "high",
        "--session",
        expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
        "--tools",
        "read",
        "--config",
        expect.any(String),
      ],
    });
  });

  test("maps permissions and sends the selected OMP response", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.requestToolApproval({ id: "approval-1", tool: "bash", detail: "git status" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "approval-1", name: "bash", kind: "tool" }),
    ]);

    await omp.respondToPermission("approval-1", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "approval-1", response: { value: "Approve" } },
    ]);
  });

  test("exposes OMP modes and commands through the domain session", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "review", description: "Review changes", source: "skill" }]);
    await omp.start();

    await expect(omp.availableModes()).resolves.toEqual([
      expect.objectContaining({ id: "full" }),
      expect.objectContaining({ id: "write" }),
      expect.objectContaining({ id: "ask" }),
    ]);
    await expect(omp.commands()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "handoff" }),
        expect.objectContaining({ name: "review", kind: "skill" }),
      ]),
    );
    await expect(omp.setMode("ask")).resolves.toEqual({
      type: "warning",
      message: "Start a new OMP session to change approval mode",
    });
  });

  test("rewinds natively, interrupts, and shuts down", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.rewind("user-history", "from history");
    expect(omp.branchRequests()).toEqual(["user-history"]);

    await omp.interruptActiveTurn("stop me");
    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);

    await omp.close();
    expect(omp.isClosed()).toBe(true);
  });

  test("interrupt terminalizes in-flight tool calls and running subagents", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("run something slow");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "tool-1",
        index: 0,
      },
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-1"]);
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);

    await omp.interrupt();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.subagentUpserts()).toEqual([
      { id: "child-1", status: "running" },
      { id: "child-1", status: "canceled" },
    ]);

    // Late progress after interrupt must not resurrect a running card.
    runtime.emit({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        agent: "worker",
        index: 0,
        progress: { id: "child-1", status: "running" },
        parentToolCallId: "tool-1",
      },
    });
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("interrupt keeps a live OMP process when abort misses its ack window", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("slow to acknowledge");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-slow",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.failNextAbort(new Error("OMP RPC request timed out for abort"));

    await expect(omp.interrupt()).rejects.toThrow("timed out for abort");

    // The turn is still really running, so nothing is terminalized and the
    // process survives; the abort is retried with a wider budget instead.
    expect(omp.isClosed()).toBe(false);
    expect(omp.isRuntimeAlive()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(0);
    expect(omp.runningToolCallIds()).toEqual(["tool-slow"]);
    expect(runtime.abortTimeoutBudgets).toEqual([undefined, 30_000]);
  });

  test("a second interrupt force-closes while the first abort is still unanswered", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("genuinely hung tool call");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-stuck",
      toolName: "bash",
      args: { command: "sleep 999" },
    });
    const timedOut = () => new Error("OMP RPC request timed out for abort");
    // Interactive abort, its background retry, then the second Stop.
    runtime.failNextAbort(timedOut());
    runtime.failNextAbort(timedOut());
    runtime.failNextAbort(timedOut());

    await expect(omp.interrupt()).rejects.toThrow("timed out for abort");
    await omp.interrupt();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.isClosed()).toBe(true);
    // A prompt after this must reload the session instead of dying against a
    // runtime that is no longer there.
    expect(omp.isRuntimeAlive()).toBe(false);
  });

  test("interrupt force-closes immediately when the OMP process is already dead", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("orphaned turn");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-orphan",
      toolName: "bash",
      args: { command: "sleep 999" },
    });
    runtime.failNextAbort(new Error("OMP RPC process is closed"));

    await omp.interrupt();

    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.isClosed()).toBe(true);
  });

  test("a crashed OMP process reports a dead runtime", async () => {
    const omp = new OmpHarness();
    await omp.start();
    expect(omp.isRuntimeAlive()).toBe(true);

    await omp.requireStartTurn("work that outlives its process");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({ type: "process_exit", error: "OMP RPC process exited with code 1" });

    // Nothing closed the session, so `closed` alone would still say "alive".
    expect(omp.isClosed()).toBe(false);
    expect(omp.isRuntimeAlive()).toBe(false);
  });

  test("a resumed session does not re-emit replayed events as live timeline items", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });

    const runtime = omp.runtime();
    // OMP replays pre-existing conversation on startup with --session.
    runtime.acceptPrompt("continue the audit", "user-history");
    runtime.streamAssistantText("audit context restored", "assistant-history");
    expect(omp.timeline()).toEqual([]);

    // The first live prompt flows normally.
    await expect(omp.runPrompt("next step", "on it")).resolves.toMatchObject({
      finalText: "on it",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "next step", messageId: "user-1" },
      { type: "assistant_message", text: "on it", messageId: "omp-assistant-1" },
    ]);
  });

  test("re-emitted user message_end frames dedupe by native entry id", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    // OMP can re-send message_end for an entry it already surfaced.
    omp.runtime().acceptPrompt("hello OMP", "user-1");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
    ]);
  });
  test("emits context usage after assistant message_end before turn idle", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const runtime = omp.runtime();
    runtime.stats = {
      tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
      cost: 0.01,
      contextUsage: { tokens: 1_234, contextWindow: 500_000 },
    };
    runtime.state = {
      ...runtime.state,
      contextUsage: { tokens: 1_234, contextWindow: 500_000 },
    };

    await omp.requireStartTurn("hello");
    runtime.beginTurn();
    runtime.acceptPrompt("hello", "user-1");
    runtime.streamAssistantText("working");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (omp.streamEvents().some((event) => event.type === "usage_updated")) break;
      await waitForImmediate();
    }
    expect(omp.streamEvents().find((event) => event.type === "usage_updated")).toMatchObject({
      type: "usage_updated",
      usage: {
        contextWindowMaxTokens: 500_000,
        contextWindowUsedTokens: 1_234,
        inputTokens: 100,
        outputTokens: 20,
      },
    });

    runtime.finishTurn();
  });

  test("refreshes context usage after a /shake custom notice", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const runtime = omp.runtime();
    runtime.stats = {
      tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
      cost: 0.01,
      contextUsage: { tokens: 369_000, contextWindow: 500_000 },
    };
    runtime.state = {
      ...runtime.state,
      contextUsage: { tokens: 369_000, contextWindow: 500_000 },
    };

    await omp.requireStartTurn("/shake");
    runtime.beginTurn();
    runtime.acceptPrompt("/shake", "user-shake");

    // Simulate OMP freeing tokens via /shake, then emitting the notice.
    runtime.stats = {
      ...runtime.stats,
      contextUsage: { tokens: 149_000, contextWindow: 500_000 },
    };
    runtime.state = {
      ...runtime.state,
      contextUsage: { tokens: 149_000, contextWindow: 500_000 },
    };
    runtime.acceptCustomMessage("Shook 252 tool results + 5 blocks (~219613 tokens freed).");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const latest = [...omp.streamEvents()]
        .toReversed()
        .find((event) => event.type === "usage_updated");
      if (
        latest &&
        latest.type === "usage_updated" &&
        latest.usage?.contextWindowUsedTokens === 149_000
      ) {
        break;
      }
      await waitForImmediate();
    }

    const usageEvents = omp
      .streamEvents()
      .filter((event) => event.type === "usage_updated") as Array<{
      type: "usage_updated";
      usage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number };
    }>;
    expect(usageEvents.at(-1)).toMatchObject({
      type: "usage_updated",
      usage: {
        contextWindowMaxTokens: 500_000,
        contextWindowUsedTokens: 149_000,
      },
    });
  });
});
