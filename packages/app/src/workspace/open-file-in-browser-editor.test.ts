import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/stores/browser-store", () => ({
  createWorkspaceBrowser: vi.fn(() => ({ browserId: "new-browser", url: "http://x" })),
  getBrowserRecord: vi.fn(),
  useBrowserStore: {
    getState: vi.fn(() => ({
      requestNavigation: vi.fn(),
    })),
  },
}));

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import { tryOpenFileInBrowserEditor } from "./open-file-in-browser-editor";

describe("tryOpenFileInBrowserEditor", () => {
  beforeEach(() => {
    vi.mocked(getIsElectron).mockReturnValue(true);
    vi.mocked(getBrowserRecord).mockReset();
    vi.mocked(createWorkspaceBrowser).mockClear();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      requestNavigation: vi.fn(),
    } as never);
  });

  it("returns false when not Electron", () => {
    vi.mocked(getIsElectron).mockReturnValue(false);
    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        location: { path: "src/a.ts" },
        workspaceTabs: [],
        openWorkspaceTabFocused: vi.fn(),
        navigateToTabId: vi.fn(),
      }),
    ).toBe(false);
  });

  it("creates a browser tab when none exists for the editor origin", () => {
    const openWorkspaceTabFocused = vi.fn(() => "tab-1");
    const navigateToTabId = vi.fn();
    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        location: { path: "src/a.ts", lineStart: 3 },
        workspaceTabs: [],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);
    expect(createWorkspaceBrowser).toHaveBeenCalled();
    const initialUrl = vi.mocked(createWorkspaceBrowser).mock.calls[0]?.[0]?.initialUrl ?? "";
    expect(initialUrl).toContain("folder=%2Frepo");
    expect(initialUrl).toContain("payload=");
    expect(openWorkspaceTabFocused).toHaveBeenCalledWith({
      kind: "browser",
      browserId: "new-browser",
    });
    expect(navigateToTabId).toHaveBeenCalledWith("tab-1");
  });

  it("reuses an existing browser tab for the same origin", () => {
    vi.mocked(getBrowserRecord).mockReturnValue({
      browserId: "existing",
      url: "http://blrofc3:8765/?folder=%2Frepo",
      title: "",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastError: null,
      createdAt: 0,
    });
    const requestNavigation = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({ requestNavigation } as never);
    const navigateToTabId = vi.fn();

    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        location: { path: "/repo/b.ts" },
        workspaceTabs: [
          { tabId: "tab-existing", target: { kind: "browser", browserId: "existing" } },
        ],
        openWorkspaceTabFocused: vi.fn(),
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).not.toHaveBeenCalled();
    expect(requestNavigation).toHaveBeenCalled();
    expect(navigateToTabId).toHaveBeenCalledWith("tab-existing");
  });
});
