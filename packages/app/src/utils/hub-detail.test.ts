import { describe, expect, it } from "vitest";
import { parseHubToolCallDetail } from "./hub-detail";

describe("parseHubToolCallDetail", () => {
  it("returns null for non-hub tools", () => {
    expect(
      parseHubToolCallDetail(
        { type: "unknown", input: { op: "wait", ids: ["bg_14"] }, output: null },
        "bash",
      ),
    ).toBeNull();
  });

  it("parses a hub wait call with job results", () => {
    const model = parseHubToolCallDetail(
      {
        type: "unknown",
        input: { op: "wait", ids: ["bg_14"], timeoutMs: 60000 },
        output: {
          content: [
            {
              type: "text",
              text: "## Still Running (1)\n\n- `bg_14` [bash] — pnpm run build:daemon-web-ui",
            },
          ],
          details: {
            op: "wait",
            jobs: [
              {
                id: "bg_14",
                type: "bash",
                status: "running",
                label: "pnpm run build:daemon-web-ui",
                durationMs: 69362,
              },
            ],
          },
        },
      },
      "hub",
    );
    expect(model).toMatchObject({
      op: "wait",
      target: "bg_14",
      timeoutMs: 60000,
      jobs: [
        {
          id: "bg_14",
          status: "running",
          type: "bash",
          label: "pnpm run build:daemon-web-ui",
          durationMs: 69362,
        },
      ],
    });
    expect(model?.notice).toContain("Still Running");
  });

  it("parses hub send/start fields without jobs", () => {
    const model = parseHubToolCallDetail(
      {
        type: "unknown",
        input: { op: "send", to: "worker", text: "hello" },
        output: null,
      },
      "hub",
    );
    expect(model).toMatchObject({ op: "send", to: "worker", text: "hello", jobs: [] });
  });
});
