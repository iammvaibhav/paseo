import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import {
  MissionControlToolsExecuteRequestSchema,
  MissionControlToolsExecuteResponseSchema,
} from "./types.js";

// M12 mission_control.tools.execute: the ONE catalog path for fleet tools,
// shared by the Voice node and the Commander. These tests pin the wire shapes
// and their membership in the session inbound/outbound unions (the daemon's
// zod-aot validator derives from the same schemas).

describe("mission_control.tools.execute request", () => {
  test("parses with only name (args optional)", () => {
    const parsed = MissionControlToolsExecuteRequestSchema.parse({
      type: "mission_control.tools.execute.request",
      requestId: "req-exec-1",
      name: "fleet_list_agents",
    });
    expect(parsed.name).toBe("fleet_list_agents");
    expect(parsed.args).toBeUndefined();
    // Membership in the session inbound union.
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "mission_control.tools.execute.request",
        requestId: "req-exec-1",
        name: "fleet_list_agents",
      }).success,
    ).toBe(true);
  });

  test("accepts an args record", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "mission_control.tools.execute.request",
      requestId: "req-exec-2",
      name: "fleet_list_agents",
      args: { statuses: ["running"], limit: 20 },
    });
    expect(parsed.type).toBe("mission_control.tools.execute.request");
    if (parsed.type !== "mission_control.tools.execute.request") throw new Error("unreachable");
    expect(parsed.args).toEqual({ statuses: ["running"], limit: 20 });
  });

  test("rejects a missing name", () => {
    expect(
      MissionControlToolsExecuteRequestSchema.safeParse({
        type: "mission_control.tools.execute.request",
        requestId: "req-exec-3",
      }).success,
    ).toBe(false);
  });
});

describe("mission_control.tools.execute response", () => {
  test("carries structuredContent + content when ok", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "mission_control.tools.execute.response",
      payload: {
        requestId: "req-exec-1",
        ok: true,
        name: "fleet_list_agents",
        structuredContent: {
          agents: [{ id: "agent-a", host: "local", status: "running", requiresAttention: false }],
        },
        content: "1 agent across 1 host",
      },
    });
    expect(parsed.type).toBe("mission_control.tools.execute.response");
  });

  test("carries ok:false + error with the requested name", () => {
    const parsed = MissionControlToolsExecuteResponseSchema.parse({
      type: "mission_control.tools.execute.response",
      payload: {
        requestId: "req-exec-2",
        ok: false,
        name: "fleet_list_agents",
        error: 'Tool "fleet_list_agents" is not on the Commander allowlist',
      },
    });
    expect(parsed.payload.ok).toBe(false);
    expect(parsed.payload.error).toMatch(/not on the Commander allowlist/);
    // Membership in the session outbound union.
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "mission_control.tools.execute.response",
        payload: { requestId: "req-exec-2", ok: false, name: "fleet_list_agents", error: "nope" },
      }).success,
    ).toBe(true);
  });

  test("rejects a response without the echoed name", () => {
    expect(
      MissionControlToolsExecuteResponseSchema.safeParse({
        type: "mission_control.tools.execute.response",
        payload: { requestId: "req-exec-3", ok: true },
      }).success,
    ).toBe(false);
  });
});
