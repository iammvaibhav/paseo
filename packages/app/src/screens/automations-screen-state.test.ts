import { describe, expect, it } from "vitest";
import { resolveAutomationsScreenBodyState } from "./automations-screen-state";
import type { StoredAutomation } from "@getpaseo/protocol/automation/types";
import type { AggregatedAutomation } from "@/hooks/use-automations";

function makeAutomation(id: string): AggregatedAutomation {
  const base: StoredAutomation = {
    id,
    name: id,
    kind: "github",
    enabled: true,
    target: { type: "agent", agentId: "agent-1" },
    promptTemplate: "triage {{event.title}}",
    recentRuns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, serverId: "host-1", serverName: "host" };
}

describe("resolveAutomationsScreenBodyState", () => {
  it("routes a failed loading state to the retry UI instead of the spinner", () => {
    expect(
      resolveAutomationsScreenBodyState({
        loadState: { status: "loading" },
        isError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });

  it("keeps successfully loaded rows on the content path even when an error flag lingers", () => {
    const rows = [makeAutomation("a1")];
    expect(
      resolveAutomationsScreenBodyState({
        loadState: { status: "loaded", data: rows },
        isError: true,
      }),
    ).toEqual({ kind: "content", rows });
  });

  it("shows the spinner while hosts are still connecting", () => {
    expect(
      resolveAutomationsScreenBodyState({
        loadState: { status: "connecting" },
        isError: false,
      }),
    ).toEqual({ kind: "loading" });
  });
});
