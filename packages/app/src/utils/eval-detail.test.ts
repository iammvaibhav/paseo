import { describe, expect, it } from "vitest";

import { parseEvalToolCallDetail } from "./eval-detail";

// Trimmed from a real Oh My Pi eval tool result recorded in a session file.
const EVAL_RESULT = {
  content: [{ type: "text", text: "PORT 38055\n  probe failed" }],
  details: {
    language: "python",
    languages: ["python"],
    cells: [
      {
        index: 0,
        title: "inspect stuck login page via CDP",
        code: "import json\nprint(json.dumps({}))",
        language: "python",
        output: "PORT 38055\n  probe failed",
        status: "complete",
        exitCode: 0,
        durationMs: 73,
      },
    ],
  },
  isError: false,
};

describe("parseEvalToolCallDetail", () => {
  it("builds a cell per eval cell in the result", () => {
    const model = parseEvalToolCallDetail({
      type: "unknown",
      input: { language: "py", code: "import json\nprint(json.dumps({}))" },
      output: EVAL_RESULT,
    });

    expect(model).toEqual({
      cells: [
        {
          key: "eval-cell-0",
          highlightExtension: "py",
          languageLabel: "python",
          title: "inspect stuck login page via CDP",
          code: "import json\nprint(json.dumps({}))",
          output: "PORT 38055\n  probe failed",
          status: "complete",
          exitCode: 0,
          durationMs: 73,
        },
      ],
      displayOutputs: [],
      images: [],
      notice: null,
    });
  });

  it("keeps display() values, which never reach the text output", () => {
    const model = parseEvalToolCallDetail({
      type: "unknown",
      input: { language: "py", code: "display(sorted(deps))" },
      output: {
        content: [{ type: "text", text: "37 dependencies" }],
        details: {
          language: "python",
          jsonOutputs: [["@oh-my-pi/pi-ai", "@oh-my-pi/pi-tui"]],
          cells: [{ index: 0, code: "display(sorted(deps))", output: "37 dependencies" }],
        },
      },
    });

    expect(model?.displayOutputs).toEqual([
      { key: "eval-display-0", text: '[\n  "@oh-my-pi/pi-ai",\n  "@oh-my-pi/pi-tui"\n]' },
    ]);
    // Cell language falls back to the result-level language.
    expect(model?.cells[0]?.highlightExtension).toBe("py");
    expect(model?.cells[0]?.status).toBe("complete");
  });

  it("turns detail images into data URIs", () => {
    const model = parseEvalToolCallDetail({
      type: "unknown",
      input: { language: "py", code: "plt.show()" },
      output: {
        content: [{ type: "text", text: "(displayed 1 image; no text output)" }],
        details: {
          cells: [{ index: 0, code: "plt.show()" }],
          images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        },
      },
    });

    expect(model?.images).toEqual([
      { key: "eval-image-0", source: { uri: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("renders the in-flight call from its arguments", () => {
    const model = parseEvalToolCallDetail({
      type: "unknown",
      input: { language: "js", code: "await Bun.file('x').text()", title: "read file" },
      output: null,
    });

    expect(model?.cells).toEqual([
      {
        key: "eval-cell-0",
        highlightExtension: "js",
        languageLabel: "javascript",
        title: "read file",
        code: "await Bun.file('x').text()",
        output: "",
        status: "running",
        exitCode: null,
        durationMs: null,
      },
    ]);
  });

  it("falls back to arguments plus result text when the run produced no cells", () => {
    const model = parseEvalToolCallDetail({
      type: "unknown",
      input: { language: "rb", code: "puts 1" },
      output: { content: [{ type: "text", text: "backend disabled" }], isError: true },
    });

    expect(model?.cells[0]).toMatchObject({
      highlightExtension: null,
      languageLabel: "ruby",
      output: "backend disabled",
      status: "error",
    });
  });

  it("ignores payloads that are not eval results", () => {
    expect(
      parseEvalToolCallDetail({
        type: "unknown",
        input: { command: "ls" },
        output: { content: [{ type: "text", text: "a.txt" }] },
      }),
    ).toBeNull();
    expect(parseEvalToolCallDetail({ type: "shell", command: "ls", output: "a.txt" })).toBeNull();
    // A cell list whose entries carry no code is some other tool's payload.
    expect(
      parseEvalToolCallDetail({
        type: "unknown",
        input: { language: "py", code: "print(1)" },
        output: { details: { cells: [{ index: 0, note: "no code here" }] } },
      })?.cells,
    ).toEqual([expect.objectContaining({ code: "print(1)", status: "complete" })]);
  });
});
