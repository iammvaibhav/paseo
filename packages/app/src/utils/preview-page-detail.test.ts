import { describe, expect, it } from "vitest";
import { parsePreviewPageToolCallDetail } from "./preview-page-detail";

const summary = {
  ok: true,
  width: 760,
  contentHeight: 4767,
  capturedHeight: 2400,
  consoleMessages: [{ level: "warning", text: "parser-blocking script" }],
};
const content = [
  { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
  { type: "text", text: JSON.stringify(summary) },
];

describe("parsePreviewPageToolCallDetail", () => {
  it("reads the screenshot and summary whichever client shape carries them", () => {
    const shapes = [
      { content, details: summary }, // omp
      { content, structuredContent: summary }, // MCP clients
      { content }, // text block only
    ];
    for (const output of shapes) {
      expect(
        parsePreviewPageToolCallDetail(
          { type: "unknown", input: { html: "<p>hi</p>" }, output },
          "mcp__paseo__preview_page",
        ),
      ).toEqual({
        html: "<p>hi</p>",
        url: null,
        width: 760,
        appearance: null,
        screenshotUri: "data:image/png;base64,iVBORw0KGgo",
        contentHeight: 4767,
        capturedHeight: 2400,
        consoleMessages: [{ level: "warning", text: "parser-blocking script" }],
        message: null,
      });
    }
  });

  it("keeps the reason when nothing was captured", () => {
    const model = parsePreviewPageToolCallDetail(
      {
        type: "unknown",
        input: { url: "http://localhost:5173" },
        output: {
          content: [{ type: "text", text: "Installing the preview browser" }],
          structuredContent: {
            ok: false,
            status: "installing",
            message: "Installing the preview browser",
          },
        },
      },
      "preview_page",
    );
    expect(model?.screenshotUri).toBeNull();
    expect(model?.message).toBe("Installing the preview browser");
  });

  it("ignores other tools", () => {
    expect(
      parsePreviewPageToolCallDetail({ type: "unknown", input: {}, output: {} }, "show_page"),
    ).toBeNull();
  });
});
