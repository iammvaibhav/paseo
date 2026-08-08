import { describe, expect, test } from "vitest";
import {
  MissionControlCommanderResetRequestSchema,
  MissionControlCommanderResetResponseSchema,
} from "./types.js";

describe("mission_control.commander.reset protocol pair", () => {
  test("request round-trips through the wire schema", () => {
    const parsed = MissionControlCommanderResetRequestSchema.parse({
      type: "mission_control.commander.reset.request",
      requestId: "req-reset-1",
    });
    expect(parsed).toEqual({
      type: "mission_control.commander.reset.request",
      requestId: "req-reset-1",
    });
  });

  test("response round-trips ok and error shapes", () => {
    const ok = MissionControlCommanderResetResponseSchema.parse({
      type: "mission_control.commander.reset.response",
      payload: { requestId: "req-reset-1", ok: true },
    });
    expect(ok.payload).toEqual({ requestId: "req-reset-1", ok: true });

    const failed = MissionControlCommanderResetResponseSchema.parse({
      type: "mission_control.commander.reset.response",
      payload: { requestId: "req-reset-1", ok: false, error: "Not the commander host" },
    });
    expect(failed.payload).toEqual({
      requestId: "req-reset-1",
      ok: false,
      error: "Not the commander host",
    });
  });

  test("rejects a non-reset type", () => {
    expect(() =>
      MissionControlCommanderResetRequestSchema.parse({
        type: "mission_control.commander.reset.response",
        requestId: "x",
      }),
    ).toThrow();
  });
});
