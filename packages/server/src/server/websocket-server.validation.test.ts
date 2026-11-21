import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import { formatInboundValidationError, isKnownInboundRequestType } from "./websocket-server.js";

describe("inbound validation errors", () => {
  test("a malformed create_agent_request names the failing field", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "create_agent_request",
      requestId: "r1",
      // Missing config.
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected validation failure");
    const message = formatInboundValidationError(parsed.error);
    expect(message).toMatch(/^Invalid message: field \S+ /);
    expect(message).not.toContain("Unknown request");
  });

  test("known and unknown request types discriminate", () => {
    expect(isKnownInboundRequestType("create_agent_request")).toBe(true);
    expect(isKnownInboundRequestType("nope.unknown.request")).toBe(false);
  });
});
