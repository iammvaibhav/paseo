import { readFile } from "node:fs/promises";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

function forkedEntryIds(contents: string): Array<string | undefined> {
  return contents
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { id?: string }).id);
}

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
    expect(omp.completedTurnCount()).toBe(1);
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

  test("resumes an OMP session and replays its history", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed", modeId: "ask", thinkingOptionId: "high" },
    );

    expect(omp.launchConfiguration()).toEqual({
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
      ],
    });
    await expect(omp.history()).resolves.toEqual([
      { type: "user_message", text: "continue the audit", messageId: "user-history" },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
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

  test("interrupt still cancels when OMP abort hangs or fails", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("stuck tool call");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-stuck",
      toolName: "bash",
      args: { command: "sleep 999" },
    });
    runtime.failNextAbort(new Error("OMP RPC request timed out for abort"));

    await omp.interrupt();

    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.isClosed()).toBe(true);
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

  test("forks a resumed session into a new session file without touching the source", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });
    const source = omp.launchConfiguration().session;
    if (!source) throw new Error("resumed OMP launch has no session file");
    const sourceBefore = await readFile(source, "utf8");

    const handle = await omp.forkSession();

    expect(handle.provider).toBe("omp");
    expect(handle.nativeHandle).not.toBe(source);
    expect(handle.sessionId).not.toBe("omp-session-1");
    // The fork is a distinct session file carrying the same history.
    expect(await readFile(source, "utf8")).toBe(sourceBefore);
    expect(forkedEntryIds(await readFile(handle.nativeHandle ?? "", "utf8"))).toEqual([
      handle.sessionId,
      "user-history",
      "assistant-history",
    ]);
  });

  test("a mid-turn fork cuts at the last prompt instead of a half-written turn", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });
    await omp.requireStartTurn("keep going");

    const handle = await omp.forkSession();

    // The still-streaming assistant turn is left behind; the caller carries it
    // forward as in-flight context text instead.
    expect(forkedEntryIds(await readFile(handle.nativeHandle ?? "", "utf8"))).toEqual([
      handle.sessionId,
      "user-history",
    ]);
  });

  test("rejects a fork boundary the OMP session file does not contain", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });

    await expect(omp.forkSession({ userMessageId: "user-not-here" })).rejects.toThrow(
      /no entry user-not-here/,
    );
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
