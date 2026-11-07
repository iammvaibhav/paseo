import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/desktop/browser/store", () => ({
  createWorkspaceBrowser: vi.fn(() => ({ browserId: "vscode-web-1", url: "http://x" })),
  getBrowserRecord: vi.fn(() => null),
  useBrowserStore: {
    getState: vi.fn(() => ({ requestBridgeOpen: vi.fn() })),
  },
}));

const INSTANCE: BrowserEditorInstance = {
  browserId: "vscode-web-1",
  origin: "http://blrofc3:8765",
  baseUrl: "http://blrofc3:8765",
  url: "http://blrofc3:8765/?folder=%2Frepo",
  folder: "/repo",
  workspaceFile: null,
  workspaceModeUnsupported: false,
  switchChain: Promise.resolve(),
};

vi.mock("@/workspace/preload-browser-editor", () => ({
  ensureBrowserEditorInstance: vi.fn(() => INSTANCE),
}));

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import {
  type BrowserEditorInstance,
  ensureBrowserEditorInstance,
} from "@/workspace/preload-browser-editor";
import { openBrowserEditorTab, tryOpenFileInBrowserEditor } from "./open-file-in-browser-editor";

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
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
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
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        workspaceKey: "server-1:workspace-1",
        workspaceTabs: [],
        openWorkspaceTabFocused,
        navigateToTabId,
      }),
    ).toBe(true);

    expect(createWorkspaceBrowser).toHaveBeenCalledWith({
      browserId: "vscode-web-1",
      initialUrl: INSTANCE.url,
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
      browserEditorUrl: "http://blrofc3:8765",
      workspaceDirectory: "/repo",
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

  it("keeps a workspace-mode window on its workspace file when falling back to a reload", () => {
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({ requestBridgeOpen } as never);
    vi.mocked(ensureBrowserEditorInstance).mockReturnValue({
      ...INSTANCE,
      workspaceFile: "/home/u/.paseo/vscode/paseo.code-workspace",
    });

    tryOpenFileInBrowserEditor({
      browserEditorUrl: "http://blrofc3:8765",
      workspaceDirectory: "/repo",
      workspaceKey: "server-1:workspace-1",
      location: { path: "src/a.ts" },
      workspaceTabs: [],
      openWorkspaceTabFocused: vi.fn(() => "tab-1"),
      navigateToTabId: vi.fn(),
    });

    const fallbackUrl = new URL(requestBridgeOpen.mock.calls[0]?.[1].fallbackUrl);
    expect(fallbackUrl.searchParams.get("workspace")).toBe(
      "/home/u/.paseo/vscode/paseo.code-workspace",
    );
    expect(fallbackUrl.searchParams.get("folder")).toBeNull();
    expect(fallbackUrl.searchParams.get("payload")).toContain("/repo/src/a.ts");
  });

  it("asks the bridge for a diff against the pane's base ref", () => {
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({ requestBridgeOpen } as never);

    expect(
      tryOpenFileInBrowserEditor({
        browserEditorUrl: "http://blrofc3:8765",
        workspaceDirectory: "/repo",
        workspaceKey: "server-1:workspace-1",
        location: { path: "src/a.ts" },
        mode: "diff",
        baseRef: "master",
        workspaceTabs: [],
        openWorkspaceTabFocused: vi.fn(() => "tab-1"),
        navigateToTabId: vi.fn(),
      }),
    ).toBe(true);

    expect(requestBridgeOpen).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.objectContaining({ path: "/repo/src/a.ts", mode: "diff", baseRef: "master" }),
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

describe("tryOpenFileInBrowserEditor outside the workspace", () => {
  const open = (path: string) => {
    const requestBridgeOpen = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({ requestBridgeOpen } as never);
    const opened = tryOpenFileInBrowserEditor({
      browserEditorUrl: "http://blrofc3:8765",
      workspaceDirectory: "/repo",
      workspaceKey: "server-1:workspace-1",
      location: { path },
      workspaceTabs: [],
      openWorkspaceTabFocused: vi.fn(() => "tab-1"),
      navigateToTabId: vi.fn(),
    });
    return { opened, request: requestBridgeOpen.mock.calls[0]?.[1] };
  };

  it("opens an absolute host path in the editor that stays rooted at the workspace", () => {
    const { opened, request } = open("/etc/hosts");
    expect(opened).toBe(true);
    expect(ensureBrowserEditorInstance).toHaveBeenLastCalledWith({
      browserEditorUrl: "http://blrofc3:8765",
      folder: "/repo",
    });
    expect(request).toEqual(expect.objectContaining({ path: "/etc/hosts" }));
  });

  it("passes a ~ path through for the host to expand, with no reload fallback", () => {
    const { opened, request } = open("~/.omp/agent/config.yml");
    expect(opened).toBe(true);
    expect(request).toEqual(
      expect.objectContaining({ path: "~/.omp/agent/config.yml", fallbackUrl: null }),
    );
  });
});
