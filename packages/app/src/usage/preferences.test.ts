import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_PREFERENCES,
  setUsageDisplayAs,
  setUsageHost,
  UsagePreferencesSchema,
} from "./preferences";

describe("usage preferences", () => {
  it("switches between used and remaining", () => {
    expect(setUsageDisplayAs(DEFAULT_USAGE_PREFERENCES, "remaining")).toEqual({
      ...DEFAULT_USAGE_PREFERENCES,
      displayAs: "remaining",
    });
  });

  it("remembers the picked host", () => {
    expect(setUsageHost(DEFAULT_USAGE_PREFERENCES, "server")).toEqual({
      ...DEFAULT_USAGE_PREFERENCES,
      serverId: "server",
    });
  });

  it("reads preferences saved before hosts could be picked as no pick", () => {
    expect(UsagePreferencesSchema.parse({ displayAs: "remaining" })).toEqual({
      ...DEFAULT_USAGE_PREFERENCES,
      displayAs: "remaining",
    });
  });

  it("drops the pins that earlier versions saved", () => {
    expect(
      UsagePreferencesSchema.parse({
        displayAs: "remaining",
        serverId: "host",
        pins: [{ sourceId: "codex", windowId: "weekly" }],
        pinned: [{ sourceId: "codex", windowId: "weekly" }],
      }),
    ).toEqual({ ...DEFAULT_USAGE_PREFERENCES, displayAs: "remaining", serverId: "host" });
  });
});
