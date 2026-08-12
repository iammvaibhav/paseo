import { describe, expect, test } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  buildSidebarWorkspaceAgents,
  sortSidebarWorkspaceAgents,
  type SidebarAgentEntry,
} from "./use-sidebar-workspace-agents";

function agent(input: {
  id: string;
  workspaceId: string;
  parentAgentId?: string | null;
  labels?: Record<string, string>;
  archivedAt?: Date;
  createdAt?: string;
  lastActivityAt?: string;
}): Agent {
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00.000Z";
  const lastActivityAt = input.lastActivityAt ?? createdAt;
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    activeTurn: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(lastActivityAt),
    lastUserMessageAt: null,
    lastActivityAt: new Date(lastActivityAt),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: input.id,
    name: null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    features: [],
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    stoppedBy: null,
    archivedAt: input.archivedAt,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
    projectPlacement: null,
    providerUnavailable: false,
  };
}

describe("buildSidebarWorkspaceAgents", () => {
  test("lists root agents of the workspace in record order", () => {
    const agents = new Map([
      ["a1", agent({ id: "a1", workspaceId: "ws-1", createdAt: "2026-01-02T00:00:00.000Z" })],
      ["a2", agent({ id: "a2", workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00.000Z" })],
    ]);
    expect(buildSidebarWorkspaceAgents(agents, "ws-1").map((entry) => entry.agentId)).toEqual([
      "a1",
      "a2",
    ]);
  });

  test("drops agents of other workspaces", () => {
    const agents = new Map([
      ["a1", agent({ id: "a1", workspaceId: "ws-1" })],
      ["a2", agent({ id: "a2", workspaceId: "ws-2" })],
    ]);
    expect(buildSidebarWorkspaceAgents(agents, "ws-1").map((entry) => entry.agentId)).toEqual([
      "a1",
    ]);
  });

  test("drops archived agents", () => {
    const agents = new Map([
      ["a1", agent({ id: "a1", workspaceId: "ws-1" })],
      ["a2", agent({ id: "a2", workspaceId: "ws-1", archivedAt: new Date("2026-01-03") })],
    ]);
    expect(buildSidebarWorkspaceAgents(agents, "ws-1").map((entry) => entry.agentId)).toEqual([
      "a1",
    ]);
  });

  test("drops subagents whose parent shares the workspace", () => {
    const agents = new Map([
      ["root", agent({ id: "root", workspaceId: "ws-1" })],
      ["child", agent({ id: "child", workspaceId: "ws-1", parentAgentId: "root" })],
    ]);
    expect(buildSidebarWorkspaceAgents(agents, "ws-1").map((entry) => entry.agentId)).toEqual([
      "root",
    ]);
  });

  test("keeps an agent whose parent lives in a different workspace (Mission Control worker)", () => {
    const agents = new Map([
      ["commander", agent({ id: "commander", workspaceId: "ws-home" })],
      ["worker", agent({ id: "worker", workspaceId: "ws-1", parentAgentId: "commander" })],
    ]);
    expect(buildSidebarWorkspaceAgents(agents, "ws-1").map((entry) => entry.agentId)).toEqual([
      "worker",
    ]);
  });

  test("drops History Ask machinery agents", () => {
    const agents = new Map([
      ["real", agent({ id: "real", workspaceId: "ws-1" })],
      ["ask", agent({ id: "ask", workspaceId: "ws-1", labels: { "paseo.history-ask": "1" } })],
    ]);
    expect(buildSidebarWorkspaceAgents(agents, "ws-1").map((entry) => entry.agentId)).toEqual([
      "real",
    ]);
  });

  test("returns an empty list for an undefined agent set", () => {
    expect(buildSidebarWorkspaceAgents(undefined, "ws-1")).toEqual([]);
  });

  test("carries title, name, timestamps and bucket", () => {
    const agents = new Map([
      [
        "a1",
        {
          ...agent({ id: "a1", workspaceId: "ws-1" }),
          title: "User title",
          name: "Erwin",
          requiresAttention: true,
          attentionReason: "permission" as const,
          pendingPermissions: [{ id: "p1" } as never],
          status: "running" as const,
        },
      ],
    ]);
    const [entry] = buildSidebarWorkspaceAgents(agents, "ws-1");
    expect(entry).toMatchObject({
      agentId: "a1",
      title: "User title",
      name: "Erwin",
      statusBucket: "needs_input",
      requiresAttention: true,
    });
    expect(entry.createdAt.getTime()).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
  });
});

describe("sortSidebarWorkspaceAgents", () => {
  function entry(id: string, createdAt: string, lastActivityAt: string): SidebarAgentEntry {
    return {
      agentId: id,
      title: id,
      name: null,
      model: null,
      statusBucket: "done",
      requiresAttention: false,
      createdAt: new Date(createdAt),
      lastActivityAt: new Date(lastActivityAt),
    };
  }

  const agents = [
    entry("old-but-active", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z"),
    entry("new-but-idle", "2026-01-04T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    entry("middle", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z"),
  ];

  test("sorts by last activity, newest first, by default", () => {
    expect(sortSidebarWorkspaceAgents(agents, "activity").map((a) => a.agentId)).toEqual([
      "old-but-active",
      "middle",
      "new-but-idle",
    ]);
  });

  test("sorts by creation time, newest first, when asked", () => {
    expect(sortSidebarWorkspaceAgents(agents, "created").map((a) => a.agentId)).toEqual([
      "new-but-idle",
      "middle",
      "old-but-active",
    ]);
  });

  test("breaks timestamp ties deterministically by id", () => {
    const tied = [
      entry("b", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      entry("a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    ];
    expect(sortSidebarWorkspaceAgents(tied, "activity").map((a) => a.agentId)).toEqual(["a", "b"]);
    expect(sortSidebarWorkspaceAgents(tied, "created").map((a) => a.agentId)).toEqual(["a", "b"]);
  });

  test("returns a zero- or one-agent list unchanged", () => {
    expect(sortSidebarWorkspaceAgents([], "activity")).toEqual([]);
    expect(sortSidebarWorkspaceAgents([agents[0]], "created")).toEqual([agents[0]]);
  });
});
