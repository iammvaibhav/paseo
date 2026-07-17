/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/components/browser-webview-resident", () => ({
  ensurePersistentBrowserWebview: vi.fn(),
  hidePersistentBrowserWebview: vi.fn(() => true),
  navigatePersistentBrowserWebview: vi.fn(() => true),
  removePersistentBrowserWebview: vi.fn(),
}));

let nextBrowserId = 0;
vi.mock("@/stores/browser-store", () => ({
  createBrowserId: vi.fn(() => `vscode-web-${(nextBrowserId += 1)}`),
  getBrowserRecord: vi.fn(() => null),
  useBrowserStore: {
    getState: vi.fn(() => ({ updateBrowser: vi.fn(), requestNavigation: vi.fn() })),
  },
}));

vi.mock("@/stores/workspace-layout-store", () => ({
  collectAllTabs: vi.fn((root) => root.tabs ?? []),
  useWorkspaceLayoutStore: {
    getState: vi.fn(() => ({ layoutByWorkspace: {}, closeTab: vi.fn() })),
  },
}));

import { getIsElectron } from "@/constants/platform";
import {
  ensurePersistentBrowserWebview,
  navigatePersistentBrowserWebview,
} from "@/components/browser-webview-resident";
import { createBrowserId, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  ensureBrowserEditorInstance,
  isBrowserEditorInstance,
  resetBrowserEditorInstancesForTests,
  usePreloadBrowserEditor,
} from "./preload-browser-editor";

const HOST = "http://blrofc3:8765";

beforeEach(() => {
  resetBrowserEditorInstancesForTests();
  nextBrowserId = 0;
  vi.clearAllMocks();
  vi.mocked(getIsElectron).mockReturnValue(true);
  vi.mocked(navigatePersistentBrowserWebview).mockReturnValue(true);
  vi.mocked(getBrowserRecord).mockReturnValue(null);
  vi.mocked(useBrowserStore.getState).mockReturnValue({
    browsersById: {},
    updateBrowser: vi.fn(),
    requestNavigation: vi.fn(),
    removeBrowser: vi.fn(),
  } as never);
  vi.mocked(useWorkspaceLayoutStore.getState).mockReturnValue({
    layoutByWorkspace: {},
    closeTab: vi.fn(),
  } as never);
});

describe("ensureBrowserEditorInstance", () => {
  it("returns null off Electron", () => {
    vi.mocked(getIsElectron).mockReturnValue(false);
    expect(
      ensureBrowserEditorInstance({ browserEditorUrl: HOST, folderUrl: `${HOST}/?folder=%2Frepo` }),
    ).toBeNull();
  });

  it("creates exactly one instance per origin and reuses it", () => {
    const first = ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folderUrl: `${HOST}/?folder=%2Frepo`,
    });
    const second = ensureBrowserEditorInstance({
      browserEditorUrl: `${HOST}/some/deep/path`,
      folderUrl: `${HOST}/?folder=%2Fother`,
    });

    expect(first).not.toBeNull();
    expect(second?.browserId).toBe(first?.browserId);
    // A second browserId is never minted for the same origin.
    expect(createBrowserId).toHaveBeenCalledTimes(1);
    expect(isBrowserEditorInstance(first?.browserId ?? "")).toBe(true);
    expect(second?.folderUrl).toContain("other");
    expect(navigatePersistentBrowserWebview).toHaveBeenCalledWith(
      first?.browserId,
      expect.stringContaining("other"),
    );
    // The warm webview is (re-)ensured on both calls.
    expect(ensurePersistentBrowserWebview).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct instances per origin", () => {
    const a = ensureBrowserEditorInstance({
      browserEditorUrl: "http://host-a:8765",
      folderUrl: "http://host-a:8765/?folder=%2Fa",
    });
    const b = ensureBrowserEditorInstance({
      browserEditorUrl: "http://host-b:8765",
      folderUrl: "http://host-b:8765/?folder=%2Fb",
    });
    expect(a?.browserId).not.toBe(b?.browserId);
  });

  it("adopts the newest persisted embedded record and removes stale duplicates", () => {
    const removeBrowser = vi.fn();
    const updateBrowser = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      browsersById: {
        old: {
          browserId: "old",
          chrome: "embedded",
          url: `${HOST}/?folder=%2Fold`,
          createdAt: 1,
        },
        current: {
          browserId: "current",
          chrome: "embedded",
          url: `${HOST}/?folder=%2Fcurrent`,
          createdAt: 2,
        },
      },
      removeBrowser,
      updateBrowser,
    } as never);

    const instance = ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folderUrl: `${HOST}/?folder=%2Frepo`,
    });

    expect(instance?.browserId).toBe("current");
    expect(createBrowserId).not.toHaveBeenCalled();
    expect(removeBrowser).toHaveBeenCalledWith("old");
    expect(instance?.folderUrl).toContain("repo");
    expect(updateBrowser).toHaveBeenCalledWith("current", {
      url: `${HOST}/?folder=%2Frepo`,
    });
  });
});

describe("usePreloadBrowserEditor", () => {
  it("does nothing while the workspace is not active", () => {
    renderHook(() =>
      usePreloadBrowserEditor({
        browserEditorUrl: HOST,
        workspaceDirectory: "/repo-a",
        workspaceKey: "server-1:workspace-a",
        isActive: false,
      }),
    );
    expect(ensurePersistentBrowserWebview).not.toHaveBeenCalled();
  });

  it("re-roots the parked instance to the newly-active workspace folder", () => {
    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: {
        browserEditorUrl: HOST,
        workspaceDirectory: "/repo-a",
        workspaceKey: "server-1:workspace-a",
        isActive: true,
      },
    });
    expect(ensurePersistentBrowserWebview).toHaveBeenCalledTimes(1);

    // Switch to another workspace on the same host → background re-root.
    rerender({
      browserEditorUrl: HOST,
      workspaceDirectory: "/repo-b",
      workspaceKey: "server-1:workspace-b",
      isActive: true,
    });
    expect(navigatePersistentBrowserWebview).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.stringContaining("repo-b"),
    );
  });

  it("re-roots via the store when the webview is adopted (not parked)", () => {
    const updateBrowser = vi.fn();
    const requestNavigation = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      updateBrowser,
      requestNavigation,
    } as never);
    vi.mocked(navigatePersistentBrowserWebview).mockReturnValue(false);
    vi.mocked(getBrowserRecord).mockReturnValue({ browserId: "vscode-web-1" } as never);

    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: {
        browserEditorUrl: HOST,
        workspaceDirectory: "/repo-a",
        workspaceKey: "server-1:workspace-a",
        isActive: true,
      },
    });
    rerender({
      browserEditorUrl: HOST,
      workspaceDirectory: "/repo-b",
      workspaceKey: "server-1:workspace-b",
      isActive: true,
    });

    expect(requestNavigation).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.stringContaining("repo-b"),
    );
    expect(updateBrowser).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.objectContaining({ url: expect.stringContaining("repo-b") }),
    );
  });

  it("retains the editor tab in inactive workspaces", () => {
    const closeTab = vi.fn();
    vi.mocked(useWorkspaceLayoutStore.getState).mockReturnValue({
      layoutByWorkspace: {
        "server-1:workspace-a": {
          root: {
            tabs: [
              {
                tabId: "browser-tab-a",
                target: { kind: "browser", browserId: "vscode-web-1" },
              },
            ],
          },
        },
      },
      closeTab,
    } as never);

    renderHook(() =>
      usePreloadBrowserEditor({
        browserEditorUrl: HOST,
        workspaceDirectory: "/repo-b",
        workspaceKey: "server-1:workspace-b",
        isActive: true,
      }),
    );

    expect(closeTab).not.toHaveBeenCalled();
  });
});
