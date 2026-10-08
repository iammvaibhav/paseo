import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  aggregateAskStatusBucket,
  buildAskPillPresentation,
  resolveAskTitle,
} from "./track-presentation";

function ask(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    serverId: "server-1",
    provider: "claude",
    status: "idle",
    activeTurn: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    model: null,
    parentAgentId: "parent",
    labels: { "paseo.selection-ask": "1" },
    ...overrides,
  } as Agent;
}

const mockTranslate = ((key: string, options?: { count?: number }) => {
  if (key === "selectionAsks.pillLabelOne") return "1 ask";
  if (key === "selectionAsks.pillLabelMany") return `${options?.count ?? 0} asks`;
  return key;
}) as unknown as TFunction;
describe("aggregateAskStatusBucket", () => {
  it("has no bucket without asks", () => {
    expect(aggregateAskStatusBucket([])).toBeNull();
  });

  it("has no bucket when every ask is done", () => {
    expect(
      aggregateAskStatusBucket([
        ask({ id: "a", status: "idle" }),
        ask({ id: "b", status: "idle" }),
      ]),
    ).toBeNull();
  });

  it("reports running when any ask is running", () => {
    expect(
      aggregateAskStatusBucket([
        ask({ id: "a", status: "idle" }),
        ask({ id: "b", status: "running" }),
      ]),
    ).toBe("running");
  });

  it("ranks a needs-you ask above a running one", () => {
    expect(
      aggregateAskStatusBucket([
        ask({ id: "a", status: "running" }),
        ask({ id: "b", status: "error" }),
      ]),
    ).toBe("needs_input");
  });
});

describe("resolveAskTitle", () => {
  it("prefers a trimmed title", () => {
    expect(resolveAskTitle(ask({ id: "a", title: "  Why this  ", name: "ask-1" }))).toBe(
      "Why this",
    );
  });

  it("falls back to the agent name, then Ask", () => {
    expect(resolveAskTitle(ask({ id: "a", title: "  ", name: "ask-1" }))).toBe("ask-1");
    expect(resolveAskTitle(ask({ id: "a", title: null, name: null }))).toBe("Ask");
  });
});

describe("buildAskPillPresentation", () => {
  it("formats single ask presentation", () => {
    const result = buildAskPillPresentation(mockTranslate, [ask({ id: "a", status: "running" })]);
    expect(result).toEqual({
      segments: [{ bucket: "running", text: "1 ask" }],
      accessibilityLabel: "1 ask",
    });
  });

  it("formats multiple asks with null bucket when done", () => {
    const result = buildAskPillPresentation(mockTranslate, [
      ask({ id: "a", status: "idle" }),
      ask({ id: "b", status: "idle" }),
    ]);
    expect(result).toEqual({
      segments: [{ bucket: null, text: "2 asks" }],
      accessibilityLabel: "2 asks",
    });
  });
});
