import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { normalizeAgentSnapshot, projectAgentSnapshot, resolveSessionAgent } from "./agent-snapshots";

function createSnapshot(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    labels?: Record<string, unknown>;
  } = {},
): AgentSnapshotPayload {
  return {
    id: input.id ?? "agent-1",
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
    activeTurn: input.activeTurn,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    title: input.title ?? null,
    labels: (input.labels ?? {}) as AgentSnapshotPayload["labels"],
    ...(input.providerUnavailable === undefined
      ? {}
      : { providerUnavailable: input.providerUnavailable }),
  };
}

describe("normalizeAgentSnapshot", () => {
  it("round-trips identified active turns through the canonical snapshot boundary", () => {
    const snapshot = createSnapshot({
      status: "running",
      activeTurn: { turnId: "turn-1", startedAt: "2026-07-31T12:00:00.000Z" },
    });

    expect(projectAgentSnapshot(normalizeAgentSnapshot(snapshot, "server-1"))).toMatchObject({
      status: "running",
      activeTurn: snapshot.activeTurn,
    });
  });

  it("normalizes identified and legacy active turns at the snapshot boundary", () => {
    const startedAt = "2026-07-31T12:00:00.000Z";
    expect(
      normalizeAgentSnapshot(
        createSnapshot({
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt },
        }),
        "server-1",
      ).activeTurn,
    ).toEqual({ turnId: "turn-1", startedAt: new Date(startedAt) });

    expect(
      normalizeAgentSnapshot(
        createSnapshot({ status: "running", lastUserMessageAt: startedAt }),
        "server-1",
      ).activeTurn,
    ).toEqual({ turnId: null, startedAt: new Date(startedAt) });
  });

  it("derives parentAgentId from the parent label while preserving labels", () => {
    const labels = {
      [PARENT_AGENT_ID_LABEL]: "parent-1",
      "custom.label": "still-here",
    };

    const agent = normalizeAgentSnapshot(createSnapshot({ labels }), "server-1");

    expect(agent.parentAgentId).toBe("parent-1");
    expect(agent.labels).toEqual(labels);
  });

  it("trims whitespace around the parent label", () => {
    const agent = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "  parent-1 \n" } }),
      "server-1",
    );

    expect(agent.parentAgentId).toBe("parent-1");
  });

  it("maps missing, empty, and non-string parent labels to null", () => {
    const missing = normalizeAgentSnapshot(createSnapshot(), "server-1");
    const empty = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } }),
      "server-1",
    );
    const nonString = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } }),
      "server-1",
    );

    expect(missing.parentAgentId).toBeNull();
    expect(empty.parentAgentId).toBeNull();
    expect(nonString.parentAgentId).toBeNull();
  });

  it("preserves providerUnavailable from the snapshot payload", () => {
    const unavailable = normalizeAgentSnapshot(
      createSnapshot({ providerUnavailable: true }),
      "server-1",
    );
    const available = normalizeAgentSnapshot(createSnapshot(), "server-1");

    expect(unavailable.providerUnavailable).toBe(true);
    expect(available.providerUnavailable).toBe(false);
  });
});

describe("resolveSessionAgent", () => {
  function session(input: {
    agents?: AgentSnapshotPayload[];
    agentDetails?: AgentSnapshotPayload[];
  }) {
    const toMap = (snapshots: AgentSnapshotPayload[] = []) =>
      new Map(
        snapshots.map((snapshot) => [snapshot.id, normalizeAgentSnapshot(snapshot, "server-1")]),
      );
    return { agents: toMap(input.agents), agentDetails: toMap(input.agentDetails) };
  }

  it("resolves a running agent that only lives in agentDetails", () => {
    // Active agents hydrated without a project placement land in `agentDetails`.
    // The composer gates its Stop button on this status, so missing the fallback
    // hid Stop for the entire run.
    const resolved = resolveSessionAgent(
      session({ agentDetails: [createSnapshot({ id: "agent-1", status: "running" })] }),
      "agent-1",
    );

    expect(resolved?.status).toBe("running");
  });

  it("prefers the live directory when an agent is in both", () => {
    const resolved = resolveSessionAgent(
      session({
        agents: [createSnapshot({ id: "agent-1", status: "running" })],
        agentDetails: [createSnapshot({ id: "agent-1", status: "idle" })],
      }),
      "agent-1",
    );

    expect(resolved?.status).toBe("running");
  });

  it("returns null for an unknown agent, a missing id, and a missing session", () => {
    const populated = session({ agents: [createSnapshot({ id: "agent-1" })] });

    expect(resolveSessionAgent(populated, "agent-2")).toBeNull();
    expect(resolveSessionAgent(populated, undefined)).toBeNull();
    expect(resolveSessionAgent(undefined, "agent-1")).toBeNull();
  });
});
