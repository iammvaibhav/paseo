import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { filterMissionControlInspectorStream } from "./inspector-stream-filter";

const at = new Date("2026-08-09T00:00:00.000Z");
const assistant = (id: string, text: string): StreamItem => ({
  kind: "assistant_message",
  id,
  text,
  timestamp: at,
});

describe("filterMissionControlInspectorStream", () => {
  it("hides generated unsupported-history placeholders in normal mode", () => {
    const visible = assistant("visible", "User-facing answer");
    const placeholder = assistant(
      "placeholder",
      "[service_tier_change] Unsupported history record",
    );

    expect(filterMissionControlInspectorStream([visible, placeholder], false)).toEqual([visible]);
  });

  it("keeps the original stream reference when there is nothing to hide", () => {
    const items = [assistant("content", "[future_control] preserved custom content")];

    expect(filterMissionControlInspectorStream(items, false)).toBe(items);
  });

  it("keeps mapper placeholders byte-exact in verbose mode", () => {
    const items = [assistant("placeholder", "[future_control] Unsupported history record")];

    expect(filterMissionControlInspectorStream(items, true)).toBe(items);
  });
});
