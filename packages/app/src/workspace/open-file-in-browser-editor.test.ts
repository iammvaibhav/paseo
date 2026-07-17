import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/stores/browser-store", () => ({
  createWorkspaceBrowser: vi.fn(() => ({ browserId: "vscode-web-1", url: "http://x" })),
  getBrowserRecord: vi.fn(() => null),
  useBrowserStore: {
    getState: vi.fn(() => ({ requestBridgeOpen: vi.fn() })),
  },
}));

const INSTANCE = {
  browserId: "vscode-web-1",
  origin: "http://blrofc3:8765",
  folderUrl: "http://blrofc3:8765/?folder=%2Frepo",
};

vi.mock("@/workspace/preload-browser-editor", () => ({
  ensureBrowserEditorInstance: vi.fn(() => INSTANCE),
}));

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import { ensureBrowserEditorInstance } from "@/workspace/preload-browser-editor";
import {
  openBrowserEditorTab,
  openHostFileInBrowserEditor,
  tryOpenFileInBrowserEditor,
} from "./open-file-in-browser-editor";

beforeEach(() => {
  vi.mocked(getIsElectron).mockReturnValue(true);
  vi.mocked(getBrowserRecord).mockReturnValue(null);
  vi.mocked(createWorkspaceBrowser).mockClear();
  vi.mocked(ensureBrowserEditorInstance).mockReturnValue(INSTANCE);
  vi.mocked(useBrowserStore.getState).mockReturnValue({ requestBridgeOpen: vi.fn() } as never);
});

describe("openBrowserEditorTab", () => {
  it("returns false when not Electron", () => {
    vi.mocked(getIsElectron).mockReturnValue(false);
    expect(
      openBrowserEditorTab({
        url: "http://blrofc3:8765/?folder=%2Frepo",
        browserEditorUrl: "http://blrofc3:8765",
        workspaceKey: "server-1:workspace-1",
        workspaceTabs: [],
        openWorkspaceTabFocused: vi.fn(),
        navigateToTabId: vi.fn(),
      }),
    ).toBe(false);
  });

  it("creates the persistent instance record and opens a tab for it", () => {
    const openWorkspaceTabFocused = vi.fn(() => "tab-1");
    const navigateToTabId = vi.fn();

    expect(
      openBrowserEditorTab({
        url: "http://blrofc3:8765/?folder=%2Frepo",
        browserEditorUrl: "http://blrofc3:8765",
        workspaceKey: "server-1:workspace-1",
        workspaceTabs: [],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).toHaveBeenCalledWith({
      browserId: "vscode-web-1",
      initialUrl: INSTANCE.folderUrl,
      chrome: "embedded",
    });
    expect(openWorkspaceTabFocused).toHaveBeenCalledWith({
      kind: "browser",
      browserId: "vscode-web-1",
    });
    expect(navigateToTabId).toHaveBeenCalledWith("tab-1");
  });

  it("reveals the already-open tab without creating a new one", () => {
    vi.mocked(getBrowserRecord).mockReturnValue({ browserId: "vscode-web-1" } as never);
    const openWorkspaceTabFocused = vi.fn();
    const navigateToTabId = vi.fn();

    openBrowserEditorTab({
      url: "http://blrofc3:8765/?folder=%2Frepo",
      browserEditorUrl: "http://blrofc3:8765",
      workspaceKey: "server-1:workspace-1",
      workspaceTabs: [
        { tabId: "tab-existing", target: { kind: "browser", browserId: "vscode-web-1" } },
      ],
      openWorkspaceTabFocused,
      navigateToTabId,
    });

    expect(createWorkspaceBrowser).not.toHaveBeenCalled();
    expect(openWorkspaceTabFocused).not.toHaveBeenCalled();
    expect(navigateToTabId).toHaveBeenCalledWith("tab-existing");
  });
});

describe("tryOpenFileInBrowserEditor", () => {
  it("reveals the persistent instance and opens the file via the bridge", () => {
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({ requestBridgeOpen } as never);
    const openWorkspaceTabFocused = vi.fn(() => "tab-1");
    const navigateToTabId = vi.fn();

    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        workspaceKey: "server-1:workspace-1",
        location: { path: "src/a.ts", lineStart: 4 },
        workspaceTabs: [],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);

    expect(openWorkspaceTabFocused).toHaveBeenCalledWith({
      kind: "browser",
      browserId: "vscode-web-1",
    });
    expect(requestBridgeOpen).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.objectContaining({
        path: "/repo/src/a.ts",
        line: 4,
        targetWorkspaceKey: "server-1:workspace-1",
        fallbackUrl: expect.stringContaining("payload="),
      }),
    );
  });

  it("returns false when not Electron", () => {
    vi.mocked(getIsElectron).mockReturnValue(false);
    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        workspaceKey: "server-1:workspace-1",
        location: { path: "src/a.ts" },
        workspaceTabs: [],
        openWorkspaceTabFocused: vi.fn(),
        navigateToTabId: vi.fn(),
      }),
    ).toBe(false);
  });
});

describe("openHostFileInBrowserEditor", () => {
  it("opens an absolute host file via the bridge on the persistent instance", () => {
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({ requestBridgeOpen } as never);

    expect(
      openHostFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        absolutePath: "/etc/hosts",
        workspaceKey: "server-1:workspace-1",
        workspaceTabs: [],
        openWorkspaceTabFocused: vi.fn(() => "tab-1"),
        navigateToTabId: vi.fn(),
      }),
    ).toBe(true);

    expect(ensureBrowserEditorInstance).toHaveBeenCalledWith({
      browserEditorUrl: "http://blrofc3:8765",
      folderUrl: "http://blrofc3:8765/?folder=%2Frepo",
    });
    expect(requestBridgeOpen).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.objectContaining({ path: "/etc/hosts" }),
    );
  });
});
