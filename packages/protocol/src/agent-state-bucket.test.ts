import { describe, expect, it } from "vitest";
import {
  deriveAgentStateBucket,
  deriveLifecycleBucket,
  getAgentStatusPriority,
  getWorkspaceStateBucketPriority,
  type LifecycleBucketInput,
} from "./agent-state-bucket.js";

describe("deriveAgentStateBucket", () => {
  it("prioritizes pending permissions as needs_input", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("needs_input");
  });

  it("keeps legacy permission attention in needs_input", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe("needs_input");
  });

  it("prioritizes error attention before running status", () => {
    expect(
      deriveAgentStateBucket({
        status: "running",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "error",
      }),
    ).toBe("failed");
  });

  it("treats unread finished agents as attention", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe("attention");
  });

  it("does not count initializing agents as running for workspace buckets", () => {
    expect(
      deriveAgentStateBucket({
        status: "initializing",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("done");
  });
});

describe("getWorkspaceStateBucketPriority", () => {
  it("orders active buckets before done", () => {
    expect(
      ["done", "attention", "running", "failed", "needs_input"].sort(
        (left, right) =>
          getWorkspaceStateBucketPriority(left) - getWorkspaceStateBucketPriority(right),
      ),
    ).toEqual(["needs_input", "failed", "running", "attention", "done"]);
  });
});

describe("getAgentStatusPriority", () => {
  it("keeps initializing agents ahead of completed agents in agent lists", () => {
    expect(getAgentStatusPriority({ status: "initializing" })).toBeLessThan(
      getAgentStatusPriority({ status: "idle" }),
    );
  });

  it("prioritizes pending permissions before errors and running agents", () => {
    const permission = getAgentStatusPriority({ status: "running", pendingPermissionCount: 1 });
    expect(permission).toBeLessThan(
      getAgentStatusPriority({ status: "error", pendingPermissionCount: 0 }),
    );
    expect(permission).toBeLessThan(
      getAgentStatusPriority({ status: "running", pendingPermissionCount: 0 }),
    );
  });
});

describe("deriveLifecycleBucket — canonical lifecycle buckets (spec 01)", () => {
  function baseInput(overrides: Partial<LifecycleBucketInput> = {}): LifecycleBucketInput {
    return {
      pendingPermissionCount: 0,
      pendingProposalCount: 0,
      attentionReason: null,
      lastStatus: "idle",
      running: false,
      reviewState: "none",
      stopOrigin: null,
      ...overrides,
    };
  }

  it("idle, no run history -> idle", () => {
    expect(deriveLifecycleBucket(baseInput())).toBe("idle");
  });

  it("running -> running", () => {
    expect(deriveLifecycleBucket(baseInput({ running: true, lastStatus: "running" }))).toBe(
      "running",
    );
  });

  it("permission requested (live pendingPermissionCount > 0) -> needs_you", () => {
    expect(deriveLifecycleBucket(baseInput({ running: true, pendingPermissionCount: 1 }))).toBe(
      "needs_you",
    );
  });

  it("permission requested (attentionReason permission) -> needs_you", () => {
    expect(deriveLifecycleBucket(baseInput({ attentionReason: "permission" }))).toBe("needs_you");
  });

  it("error (lastStatus error) -> needs_you", () => {
    expect(deriveLifecycleBucket(baseInput({ lastStatus: "error" }))).toBe("needs_you");
  });

  it("error (attentionReason error) -> needs_you", () => {
    expect(deriveLifecycleBucket(baseInput({ attentionReason: "error" }))).toBe("needs_you");
  });

  it("pending proposal -> needs_you", () => {
    expect(deriveLifecycleBucket(baseInput({ pendingProposalCount: 1 }))).toBe("needs_you");
  });

  it("clean finish (reviewState ready) -> ready", () => {
    expect(deriveLifecycleBucket(baseInput({ reviewState: "ready" }))).toBe("ready");
  });

  it("finish + verdict done -> done", () => {
    expect(deriveLifecycleBucket(baseInput({ reviewState: "done" }))).toBe("done");
  });

  it("finish + aged out (reviewState done) -> done", () => {
    expect(deriveLifecycleBucket(baseInput({ reviewState: "done" }))).toBe("done");
  });

  it("user-stop, no review -> done (stopped-by-user)", () => {
    expect(deriveLifecycleBucket(baseInput({ stopOrigin: "user", reviewState: "none" }))).toBe(
      "done",
    );
  });

  it("user-stop with reviewState cleared -> done", () => {
    expect(deriveLifecycleBucket(baseInput({ stopOrigin: "user", reviewState: "cleared" }))).toBe(
      "done",
    );
  });

  it("user-stop then new run -> running", () => {
    expect(
      deriveLifecycleBucket(
        baseInput({ stopOrigin: "user", running: true, lastStatus: "running" }),
      ),
    ).toBe("running");
  });

  it("delegated worker finish -> ready", () => {
    expect(deriveLifecycleBucket(baseInput({ reviewState: "ready" }))).toBe("ready");
  });

  it("second finish after verdict -> ready (re-marked)", () => {
    expect(deriveLifecycleBucket(baseInput({ reviewState: "ready" }))).toBe("ready");
  });

  it("COMPAT(finished-attention): old records with attentionReason finished do NOT drive needs_you", () => {
    expect(
      deriveLifecycleBucket(baseInput({ attentionReason: "finished", reviewState: "ready" })),
    ).toBe("ready");
    expect(
      deriveLifecycleBucket(baseInput({ attentionReason: "finished", reviewState: "done" })),
    ).toBe("done");
    expect(
      deriveLifecycleBucket(baseInput({ attentionReason: "finished", reviewState: "none" })),
    ).toBe("idle");
  });

  it("user-stop excludes rule 1 so error/permission/proposals do not land stopped agent in needs_you", () => {
    expect(
      deriveLifecycleBucket(
        baseInput({
          stopOrigin: "user",
          lastStatus: "error",
          attentionReason: "error",
          reviewState: "none",
        }),
      ),
    ).toBe("done");
  });
});
