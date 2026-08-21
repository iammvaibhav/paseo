import { beforeEach, describe, expect, it } from "vitest";
import { useReopenAskStore } from "./reopen-store";

describe("reopen ask store dismiss channel", () => {
  beforeEach(() => {
    useReopenAskStore.setState({ request: null, dismissRequest: null });
  });

  it("delivers a dismiss request to the matching source agent once", () => {
    useReopenAskStore.getState().requestAskDismiss({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });

    expect(useReopenAskStore.getState().consumeAskDismiss("source-a")).toEqual({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });
    // Consumed requests are cleared, not redelivered.
    expect(useReopenAskStore.getState().consumeAskDismiss("source-a")).toBeNull();
  });

  it("keeps a dismiss request for another source agent", () => {
    useReopenAskStore.getState().requestAskDismiss({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });

    expect(useReopenAskStore.getState().consumeAskDismiss("source-b")).toBeNull();
    expect(useReopenAskStore.getState().consumeAskDismiss("source-a")).toEqual({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });
  });

  it("keeps the reopen and dismiss channels independent", () => {
    useReopenAskStore.getState().requestAskDismiss({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });
    useReopenAskStore.getState().requestReopenAsk({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });

    // Reopening a different ask must not swallow the pending dismiss.
    expect(useReopenAskStore.getState().consumeReopenAsk("source-a")).toEqual({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });
    expect(useReopenAskStore.getState().consumeAskDismiss("source-a")).toEqual({
      sourceAgentId: "source-a",
      askAgentId: "ask-1",
    });
  });

  it("returns null when no dismiss is pending", () => {
    expect(useReopenAskStore.getState().consumeAskDismiss("source-a")).toBeNull();
  });
});
