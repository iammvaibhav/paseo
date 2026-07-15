import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/stores/browser-store", () => ({
  createWorkspaceBrowser: vi.fn(() => ({ browserId: "new-browser", url: "http://x" })),
  getBrowserRecord: vi.fn(),
  resolveBrowserChromeMode: (value: "full" | "embedded" | null | undefined) =>
    value === "embedded" ? "embedded" : "full",
  useBrowserStore: {
    getState: vi.fn(() => ({
      requestNavigation: vi.fn(),
      requestBridgeOpen: vi.fn(),
    })),
  },
}));

vi.mock("@/workspace/preload-browser-editor", () => ({
  takePreloadedBrowserEditor: vi.fn(() => null),
}));

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import { takePreloadedBrowserEditor } from "@/workspace/preload-browser-editor";
import {
  openBrowserEditorTab,
  openHostFileInBrowserEditor,
  tryOpenFileInBrowserEditor,
} from "./open-file-in-browser-editor";

describe("tryOpenFileInBrowserEditor", () => {
  beforeEach(() => {
    vi.mocked(getIsElectron).mockReturnValue(true);
    vi.mocked(getBrowserRecord).mockReset();
    vi.mocked(createWorkspaceBrowser).mockClear();
    vi.mocked(takePreloadedBrowserEditor).mockReturnValue(null);
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      requestNavigation: vi.fn(),
      requestBridgeOpen: vi.fn(),
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

  it("creates an embedded browser tab when none exists for the editor origin", () => {
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
    expect(createWorkspaceBrowser).toHaveBeenCalledWith({
      initialUrl: expect.stringContaining("folder=%2Frepo"),
      chrome: "embedded",
    });
    const initialUrl = vi.mocked(createWorkspaceBrowser).mock.calls[0]?.[0]?.initialUrl ?? "";
    expect(initialUrl).toContain("payload=");
    expect(openWorkspaceTabFocused).toHaveBeenCalledWith({
      kind: "browser",
      browserId: "new-browser",
    });
    expect(navigateToTabId).toHaveBeenCalledWith("tab-1");
  });

  it("opens a file in place via the bridge when a tab already exists (no reload)", () => {
    vi.mocked(getBrowserRecord).mockReturnValue({
      browserId: "existing",
      url: "http://blrofc3:8765/?folder=%2Frepo",
      title: "",
      chrome: "embedded",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastError: null,
      createdAt: 0,
    });
    const requestNavigation = vi.fn();
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      requestNavigation,
      requestBridgeOpen,
    } as never);
    const navigateToTabId = vi.fn();

    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        location: { path: "/repo/b.ts", lineStart: 12 },
        workspaceTabs: [
          { tabId: "tab-existing", target: { kind: "browser", browserId: "existing" } },
        ],
        openWorkspaceTabFocused: vi.fn(),
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).not.toHaveBeenCalled();
    expect(requestNavigation).not.toHaveBeenCalled();
    expect(requestBridgeOpen).toHaveBeenCalledWith(
      "existing",
      expect.objectContaining({
        path: "/repo/b.ts",
        line: 12,
        fallbackUrl: expect.stringContaining("payload="),
      }),
    );
    expect(navigateToTabId).toHaveBeenCalledWith("tab-existing");
  });

  it("does not reuse a full-chrome browser tab on the same origin", () => {
    vi.mocked(getBrowserRecord).mockReturnValue({
      browserId: "full-chrome",
      url: "http://blrofc3:8765/?folder=%2Frepo",
      title: "",
      chrome: "full",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastError: null,
      createdAt: 0,
    });
    const openWorkspaceTabFocused = vi.fn(() => "tab-new");
    const navigateToTabId = vi.fn();

    expect(
      openBrowserEditorTab({
        url: "http://blrofc3:8765/?folder=%2Frepo",
        browserEditorUrl: "http://blrofc3:8765",
        workspaceTabs: [
          { tabId: "tab-full", target: { kind: "browser", browserId: "full-chrome" } },
        ],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).toHaveBeenCalledWith({
      initialUrl: "http://blrofc3:8765/?folder=%2Frepo",
      chrome: "embedded",
    });
    expect(navigateToTabId).toHaveBeenCalledWith("tab-new");
  });

  it("adopts a preloaded (warm) browser and opens the file via the bridge", () => {
    vi.mocked(takePreloadedBrowserEditor).mockReturnValue({
      browserId: "warm-id",
      origin: "http://blrofc3:8765",
      folderUrl: "http://blrofc3:8765/?folder=%2Frepo",
    });
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      requestNavigation: vi.fn(),
      requestBridgeOpen,
    } as never);
    const openWorkspaceTabFocused = vi.fn(() => "tab-warm");
    const navigateToTabId = vi.fn();

    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        location: { path: "src/a.ts", lineStart: 4 },
        workspaceTabs: [],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).toHaveBeenCalledWith({
      browserId: "warm-id",
      initialUrl: "http://blrofc3:8765/?folder=%2Frepo",
      chrome: "embedded",
    });
    expect(openWorkspaceTabFocused).toHaveBeenCalledWith({ kind: "browser", browserId: "warm-id" });
    expect(navigateToTabId).toHaveBeenCalledWith("tab-warm");
    expect(requestBridgeOpen).toHaveBeenCalledWith(
      "warm-id",
      expect.objectContaining({ path: "/repo/src/a.ts", line: 4 }),
    );
  });
});

describe("openHostFileInBrowserEditor", () => {
  beforeEach(() => {
    vi.mocked(getIsElectron).mockReturnValue(true);
    vi.mocked(getBrowserRecord).mockReset();
    vi.mocked(createWorkspaceBrowser).mockClear();
    vi.mocked(takePreloadedBrowserEditor).mockReturnValue(null);
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      requestNavigation: vi.fn(),
      requestBridgeOpen: vi.fn(),
    } as never);
  });

  it("cold-opens an absolute host file rooted at its parent directory", () => {
    const openWorkspaceTabFocused = vi.fn(() => "tab-host");
    const navigateToTabId = vi.fn();

    expect(
      openHostFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        absolutePath: "/etc/hosts",
        workspaceTabs: [],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);

    const initialUrl = vi.mocked(createWorkspaceBrowser).mock.calls[0]?.[0]?.initialUrl ?? "";
    expect(initialUrl).toContain("folder=%2Fetc");
    expect(initialUrl).toContain("payload=");
    expect(navigateToTabId).toHaveBeenCalledWith("tab-host");
  });

  it("opens a host file in place when a tab already exists", () => {
    vi.mocked(getBrowserRecord).mockReturnValue({
      browserId: "existing",
      url: "http://blrofc3:8765/?folder=%2Frepo",
      title: "",
      chrome: "embedded",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastError: null,
      createdAt: 0,
    });
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      requestNavigation: vi.fn(),
      requestBridgeOpen,
    } as never);
    const navigateToTabId = vi.fn();

    expect(
      openHostFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        absolutePath: "/var/log/system.log",
        workspaceTabs: [
          { tabId: "tab-existing", target: { kind: "browser", browserId: "existing" } },
        ],
        openWorkspaceTabFocused: vi.fn(),
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).not.toHaveBeenCalled();
    expect(requestBridgeOpen).toHaveBeenCalledWith(
      "existing",
      expect.objectContaining({ path: "/var/log/system.log" }),
    );
    expect(navigateToTabId).toHaveBeenCalledWith("tab-existing");
  });
});
