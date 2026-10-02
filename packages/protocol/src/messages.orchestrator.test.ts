import { describe, expect, test } from "vitest";

import {
  AgentSnapshotPayloadSchema,
  CreateAgentRequestMessageSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
} from "./messages.js";

describe("orchestrator start option (wire-compat)", () => {
  test("create_agent_request accepts optional orchestrator flag and keeps legacy default", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "orch-start",
      config: { provider: "codex", cwd: "/repo/app" },
      orchestrator: true,
    });
    expect(parsed).toMatchObject({ type: "create_agent_request", orchestrator: true });

    const legacy = CreateAgentRequestMessageSchema.parse({
      type: "create_agent_request",
      requestId: "orch-legacy",
      config: { provider: "codex", cwd: "/repo/app" },
      attachments: [],
    });
    expect(legacy.orchestrator).toBeUndefined();
  });

  test("agent snapshot echoes orchestrator when present, omits when absent (old daemons)", () => {
    const base = {
      id: "agent-1",
      provider: "codex",
      cwd: "/repo",
      model: null,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    };
    expect(AgentSnapshotPayloadSchema.parse({ ...base, orchestrator: true })).toMatchObject({
      orchestrator: true,
    });
    expect(
      (AgentSnapshotPayloadSchema.parse(base) as Record<string, unknown>)["orchestrator"],
    ).toBeUndefined();
  });

  test("server_info features.orchestrator is optional (old daemons omit it)", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: { orchestrator: true },
    });
    expect(parsed.features?.orchestrator).toBe(true);
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {},
    });
    expect(legacy.features?.orchestrator).toBeUndefined();
  });
});
