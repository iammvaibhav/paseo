import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import { formatInboundValidationError, isKnownInboundRequestType } from "./websocket-server.js";

describe("inbound validation errors", () => {
  test("a malformed automation.create names the failing field", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "automation.create.request",
      requestId: "r1",
      kind: "github",
      // Missing target + promptTemplate.
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected validation failure");
    const message = formatInboundValidationError(parsed.error);
    expect(message).toMatch(/^Invalid message: field \S+ /);
    expect(message).not.toContain("Unknown request");
  });

  test("known and unknown request types discriminate", () => {
    expect(isKnownInboundRequestType("automation.create.request")).toBe(true);
    expect(isKnownInboundRequestType("nope.unknown.request")).toBe(false);
  });
});
