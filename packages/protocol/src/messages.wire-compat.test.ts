import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";
import { MissionControlProposalsRespondRequestSchema } from "./mission-control/types.js";

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("mission_control.proposals.respond round-trips the optional deny reason", () => {
    // Old app (no reason) still parses on the new daemon.
    const legacy = SessionInboundMessageSchema.parse({
      type: "mission_control.proposals.respond.request",
      requestId: "req-legacy",
      proposalId: "mcp_1",
      action: "deny",
    });
    expect(legacy).toEqual({
      type: "mission_control.proposals.respond.request",
      requestId: "req-legacy",
      proposalId: "mcp_1",
      action: "deny",
    });
    // New app (with reason) parses on the new daemon and keeps the field.
    const withReason = MissionControlProposalsRespondRequestSchema.parse({
      type: "mission_control.proposals.respond.request",
      requestId: "req-reason",
      proposalId: "mcp_1",
      action: "deny",
      reason: "Run it on gamma instead.",
    });
    expect(withReason).toMatchObject({ action: "deny", reason: "Run it on gamma instead." });
    // A six-month-old daemon schema (no reason field) strips the unknown key
    // instead of failing, so a new app against an old daemon keeps working.
    const LegacyRespondRequestSchema = z.object({
      type: z.literal("mission_control.proposals.respond.request"),
      requestId: z.string(),
      proposalId: z.string(),
      action: z.enum(["approve", "deny"]),
      editedMessage: z.string().optional(),
      allowPair: z.boolean().optional(),
    });
    expect(
      LegacyRespondRequestSchema.parse({
        type: "mission_control.proposals.respond.request",
        requestId: "req-old-daemon",
        proposalId: "mcp_1",
        action: "deny",
        reason: "Run it on gamma instead.",
      }),
    ).toEqual({
      type: "mission_control.proposals.respond.request",
      requestId: "req-old-daemon",
      proposalId: "mcp_1",
      action: "deny",
    });
  });

  test("server info accepts missionControlHostAlias with and without the field", () => {
    // With the field: trimmed, junk normalized to null, never required.
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "alias-server",
        missionControlHostAlias: "  fleet-lead  ",
        features: {},
      }),
    ).toMatchObject({
      status: "server_info",
      serverId: "alias-server",
      missionControlHostAlias: "fleet-lead",
      features: {},
    });
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "alias-server",
        missionControlHostAlias: 42,
        features: {},
      }).missionControlHostAlias,
    ).toBeNull();
    // Without the field: absent, so old daemons and old payloads stay valid.
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "plain-server",
        features: {},
      }).missionControlHostAlias,
    ).toBeUndefined();
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("task progress fields are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [{ text: "Legacy task", completed: false }],
      }),
    ).toEqual({ type: "todo", items: [{ text: "Legacy task", completed: false }] });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [
          {
            id: "task-1",
            text: "Current task",
            activeForm: "Working on current task",
            status: "in_progress",
            completed: false,
          },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "task-1",
          text: "Current task",
          activeForm: "Working on current task",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("sub_agent tool-call payload still parses against the v0.1.65-beta.3 schema", () => {
    const parsed = LegacySubAgentToolCallSchema.parse({
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "[Read] README.md",
        actions: [],
      },
    });

    expect(parsed.detail.actions).toEqual([]);
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
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
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });
});
