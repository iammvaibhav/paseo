import { describe, expect, it } from "vitest";
import {
  browserEditorOriginFromUrl,
  buildBrowserEditorUrl,
  collectBrowserEditorOrigins,
} from "./browser-editor-url";

describe("buildBrowserEditorUrl", () => {
  it("appends folder as a query param", () => {
    expect(
      buildBrowserEditorUrl({
        baseUrl: "http://blrofc3:8765",
        folderPath: "/home/vaibhav/paseo",
      }),
    ).toBe("http://blrofc3:8765/?folder=%2Fhome%2Fvaibhav%2Fpaseo");
  });

  it("preserves an existing path on the base URL", () => {
    expect(
      buildBrowserEditorUrl({
        baseUrl: "http://127.0.0.1:8765/stable/",
        folderPath: "/tmp/ws",
      }),
    ).toBe("http://127.0.0.1:8765/stable/?folder=%2Ftmp%2Fws");
  });

  it("adds an openFile payload for a file path", () => {
    const url = buildBrowserEditorUrl({
      baseUrl: "http://blrofc3:8765",
      folderPath: "/home/vaibhav/paseo",
      filePath: "/home/vaibhav/paseo/src/app.ts",
    });
    expect(url).toBe(
      "http://blrofc3:8765/?folder=%2Fhome%2Fvaibhav%2Fpaseo&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F%2Fhome%2Fvaibhav%2Fpaseo%2Fsrc%2Fapp.ts%22%5D%5D",
    );
  });

  it("embeds line/column when gotoLineMode is needed", () => {
    const url = buildBrowserEditorUrl({
      baseUrl: "http://127.0.0.1:8765",
      folderPath: "/repo",
      filePath: "/repo/a.ts",
      line: 12,
      column: 4,
    });
    expect(url).toContain("payload=");
    const parsed = new URL(url!);
    expect(JSON.parse(parsed.searchParams.get("payload")!)).toEqual([
      ["gotoLineMode", "true"],
      ["openFile", "vscode-remote:///repo/a.ts:12:4"],
    ]);
  });

  it("returns null for empty inputs", () => {
    expect(buildBrowserEditorUrl({ baseUrl: "", folderPath: "/tmp" })).toBeNull();
    expect(buildBrowserEditorUrl({ baseUrl: "http://x", folderPath: "" })).toBeNull();
  });
});

describe("browserEditorOriginFromUrl", () => {
  it("returns scheme+host+port", () => {
    expect(browserEditorOriginFromUrl("http://iammvaibhav:8765/")).toBe("http://iammvaibhav:8765");
  });

  it("adds http when scheme is missing", () => {
    expect(browserEditorOriginFromUrl("blrofc3:8765")).toBe("http://blrofc3:8765");
  });
});

describe("collectBrowserEditorOrigins", () => {
  it("dedupes and sorts", () => {
    expect(
      collectBrowserEditorOrigins([
        "http://iammvaibhav:8765",
        "http://blrofc3:8765/",
        "http://iammvaibhav:8765/",
        null,
        "",
      ]),
    ).toEqual(["http://blrofc3:8765", "http://iammvaibhav:8765"]);
  });
});
