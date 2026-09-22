import { describe, expect, it, vi } from "vitest";
import { markReopenedAskDone } from "./use-selection-ask";

describe("markReopenedAskDone", () => {
  it("marks a finished ask done on reopen through the board lifecycle path", async () => {
    const lifecycleSet = vi.fn().mockResolvedValue({ ok: true, requestId: "r1" });
    await markReopenedAskDone(
      "server-1",
      "ask-1",
      () => "closed",
      () => ({ missionControlLifecycleSet: lifecycleSet }),
    );
    expect(lifecycleSet).toHaveBeenCalledTimes(1);
    expect(lifecycleSet).toHaveBeenCalledWith({
      serverId: "server-1",
      agentId: "ask-1",
      action: "done",
    });
  });

  it("does not mark a running ask done", async () => {
    const lifecycleSet = vi.fn();
    await markReopenedAskDone(
      "server-1",
      "ask-1",
      () => "running",
      () => ({ missionControlLifecycleSet: lifecycleSet }),
    );
    expect(lifecycleSet).not.toHaveBeenCalled();
  });

  it("does not mark an initializing ask done", async () => {
    const lifecycleSet = vi.fn();
    await markReopenedAskDone(
      "server-1",
      "ask-1",
      () => "initializing",
      () => ({ missionControlLifecycleSet: lifecycleSet }),
    );
    expect(lifecycleSet).not.toHaveBeenCalled();
  });

  it("skips an ask that is not in the session store", async () => {
    const lifecycleSet = vi.fn();
    await markReopenedAskDone(
      "server-1",
      "ask-1",
      () => undefined,
      () => ({ missionControlLifecycleSet: lifecycleSet }),
    );
    expect(lifecycleSet).not.toHaveBeenCalled();
  });

  it("skips when no client is available", async () => {
    const lifecycleSet = vi.fn();
    await markReopenedAskDone(
      "server-1",
      "ask-1",
      () => "idle",
      () => null,
    );
    expect(lifecycleSet).not.toHaveBeenCalled();
  });

  it("propagates a failed lifecycle write so the caller can swallow it", async () => {
    const lifecycleSet = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
    await expect(
      markReopenedAskDone(
        "server-1",
        "ask-1",
        () => "idle",
        () => ({ missionControlLifecycleSet: lifecycleSet }),
      ),
    ).rejects.toThrow("boom");
  });
});
