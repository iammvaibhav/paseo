import { describe, expect, it } from "vitest";
import {
  aggregateSidebarStateBuckets,
  deriveSidebarLifecycleBucket,
  deriveSidebarStateBucket,
  type SidebarStateBucket,
} from "./sidebar-agent-state";

describe("deriveSidebarLifecycleBucket", () => {
  it("prefers the daemon-owned canonical bucket when present", () => {
    expect(deriveSidebarLifecycleBucket({ bucket: "ready", status: "running" })).toBe("ready");
  });

  it("maps a pending permission to needs_you", () => {
    expect(deriveSidebarLifecycleBucket({ status: "idle", pendingPermissionCount: 1 })).toBe(
      "needs_you",
    );
  });

  it("maps legacy permission attention to needs_you", () => {
    expect(deriveSidebarLifecycleBucket({ status: "idle", attentionReason: "permission" })).toBe(
      "needs_you",
    );
  });

  it("maps an errored agent to needs_you even while running", () => {
    expect(deriveSidebarLifecycleBucket({ status: "error", attentionReason: "error" })).toBe(
      "needs_you",
    );
  });

  it("keeps a running agent in running", () => {
    expect(deriveSidebarLifecycleBucket({ status: "running" })).toBe("running");
  });

  it("counts initializing agents as running", () => {
    expect(deriveSidebarLifecycleBucket({ status: "initializing" })).toBe("running");
  });

  it("maps a finished run to ready for review", () => {
    expect(deriveSidebarLifecycleBucket({ status: "idle", attentionReason: "finished" })).toBe(
      "ready",
    );
  });

  it("maps a user-stopped agent to done", () => {
    expect(deriveSidebarLifecycleBucket({ status: "idle", stoppedBy: "user" })).toBe("done");
  });

  it("maps a user-stopped finished agent to done, not ready", () => {
    expect(
      deriveSidebarLifecycleBucket({
        status: "idle",
        attentionReason: "finished",
        stoppedBy: "user",
      }),
    ).toBe("done");
  });

  it("prefers an explicit reviewState over the attention-derived guess", () => {
    // The Barbara bug: an errored agent stopped by the user with a cleared
    // reviewState must read as done (the user's stop is the terminal story),
    // not needs_you from the error.
    expect(
      deriveSidebarLifecycleBucket({ status: "error", stoppedBy: "user", reviewState: "none" }),
    ).toBe("done");
    expect(
      deriveSidebarLifecycleBucket({
        status: "idle",
        attentionReason: "finished",
        reviewState: "done",
      }),
    ).toBe("done");
  });

  it("maps an idle agent with no run history to idle", () => {
    expect(deriveSidebarLifecycleBucket({ status: "idle" })).toBe("idle");
  });

  it("ignores finished attention on an old daemon record without a user stop when running", () => {
    // A finished attention latch on a restarted run: the run wins.
    expect(deriveSidebarLifecycleBucket({ status: "running", attentionReason: "finished" })).toBe(
      "running",
    );
  });
});

describe("deriveSidebarStateBucket", () => {
  it("maps needs_you to the needs_input alert", () => {
    expect(deriveSidebarStateBucket({ status: "idle", pendingPermissionCount: 1 })).toBe(
      "needs_input",
    );
    expect(deriveSidebarStateBucket({ status: "error" })).toBe("needs_input");
  });

  it("maps running to running", () => {
    expect(deriveSidebarStateBucket({ status: "running" })).toBe("running");
  });

  it("maps ready to the review attention dot", () => {
    expect(deriveSidebarStateBucket({ status: "idle", attentionReason: "finished" })).toBe(
      "attention",
    );
    expect(deriveSidebarStateBucket({ bucket: "ready", status: "idle" })).toBe("attention");
  });

  it("maps done and idle to done styling", () => {
    expect(deriveSidebarStateBucket({ status: "idle", stoppedBy: "user" })).toBe("done");
    expect(deriveSidebarStateBucket({ status: "idle" })).toBe("done");
    expect(deriveSidebarStateBucket({ bucket: "done", status: "idle" })).toBe("done");
    expect(deriveSidebarStateBucket({ bucket: "idle", status: "idle" })).toBe("done");
  });

  it("lets the daemon-owned bucket override payload fields", () => {
    expect(
      deriveSidebarStateBucket({
        bucket: "idle",
        status: "running",
        pendingPermissionCount: 1,
      }),
    ).toBe("done");
  });
});

describe("aggregateSidebarStateBuckets", () => {
  it("returns done for a project with no workspaces", () => {
    expect(aggregateSidebarStateBuckets([])).toBe("done");
  });

  it("returns done when every workspace is done", () => {
    expect(aggregateSidebarStateBuckets(["done", "done", "done"])).toBe("done");
  });

  it("surfaces a single running workspace among finished ones", () => {
    expect(aggregateSidebarStateBuckets(["done", "running", "done"])).toBe("running");
  });

  it("prefers needs_input over every other bucket", () => {
    expect(aggregateSidebarStateBuckets(["running", "attention", "failed", "needs_input"])).toBe(
      "needs_input",
    );
  });

  it("prefers failed over attention and running", () => {
    expect(aggregateSidebarStateBuckets(["running", "attention", "failed"])).toBe("failed");
  });

  it("prefers running over ready-to-review so a working project keeps its loader", () => {
    expect(aggregateSidebarStateBuckets(["attention", "running"])).toBe("running");
  });

  it("prefers ready-to-review over done", () => {
    expect(aggregateSidebarStateBuckets(["done", "attention", "done"])).toBe("attention");
  });

  it("follows the full needs_input > failed > running > attention > done ordering", () => {
    // Each pair of adjacent buckets: the more urgent one wins when both are present.
    expect(aggregateSidebarStateBuckets(["failed", "needs_input"])).toBe("needs_input");
    expect(aggregateSidebarStateBuckets(["running", "failed"])).toBe("failed");
    expect(aggregateSidebarStateBuckets(["attention", "running"])).toBe("running");
    expect(aggregateSidebarStateBuckets(["done", "attention"])).toBe("attention");
  });

  it("is order-independent", () => {
    const buckets: SidebarStateBucket[] = ["attention", "running", "failed"];
    expect(aggregateSidebarStateBuckets(buckets)).toBe(
      aggregateSidebarStateBuckets(buckets.toReversed()),
    );
  });
});
