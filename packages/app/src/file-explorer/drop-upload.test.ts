import { describe, expect, it } from "vitest";
import { droppedItemsToExplorerFiles, resolveExplorerDropDirectoryPath } from "./drop-upload";

describe("resolveExplorerDropDirectoryPath", () => {
  it("defaults to root when nothing is selected", () => {
    expect(
      resolveExplorerDropDirectoryPath({
        selectedEntryPath: null,
        directories: new Map(),
      }),
    ).toBe(".");
  });

  it("uses a selected directory path", () => {
    expect(
      resolveExplorerDropDirectoryPath({
        selectedEntryPath: "src/components",
        directories: new Map([
          [
            "src/components",
            {
              entries: [
                {
                  name: "a.ts",
                  path: "src/components/a.ts",
                  kind: "file",
                  size: 1,
                  modifiedAt: "",
                },
              ],
            },
          ],
        ]),
      }),
    ).toBe("src/components");
  });

  it("uses the parent of a selected file", () => {
    expect(
      resolveExplorerDropDirectoryPath({
        selectedEntryPath: "src/a.ts",
        directories: new Map([
          [
            ".",
            {
              entries: [
                {
                  name: "a.ts",
                  path: "src/a.ts",
                  kind: "file",
                  size: 1,
                  modifiedAt: "",
                },
              ],
            },
          ],
        ]),
      }),
    ).toBe("src");
  });
});

describe("droppedItemsToExplorerFiles", () => {
  it("includes raster images for explorer writes", async () => {
    const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const files = await droppedItemsToExplorerFiles([{ kind: "web-file", file: png }]);
    expect(files).toEqual([
      {
        fileName: "shot.png",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      },
    ]);
  });

  it("reads desktop path drops via the runtime", async () => {
    const files = await droppedItemsToExplorerFiles(
      [{ kind: "desktop-path", path: "/tmp/notes.txt" }],
      {
        readDesktopFileBytes: async (path) => {
          expect(path).toBe("/tmp/notes.txt");
          return new TextEncoder().encode("hi");
        },
      },
    );
    expect(files[0]?.fileName).toBe("notes.txt");
    expect(files[0]?.bytes).toEqual(new TextEncoder().encode("hi"));
  });
});
