/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/desktop/browser/resident-webviews", () => ({
  ensurePersistentBrowserWebview: vi.fn(),
  getPersistentBrowserWebview: vi.fn(() => null),
  isBrowserWebviewDomReady: vi.fn(() => true),
  hidePersistentBrowserWebview: vi.fn(() => true),
  navigatePersistentBrowserWebview: vi.fn(() => true),
  removePersistentBrowserWebview: vi.fn(),
}));

let nextBrowserId = 0;
vi.mock("@/desktop/browser/store", () => ({
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
  getPersistentBrowserWebview,
  navigatePersistentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import { createBrowserId, getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  ensureBrowserEditorInstance,
  isBrowserEditorInstance,
  resetBrowserEditorInstancesForTests,
  usePreloadBrowserEditor,
} from "./preload-browser-editor";

const HOST = "http://blrofc3:8765";
const WORKSPACE_FILE = "/home/u/.paseo/vscode/paseo.code-workspace";

/** A parked VS Code webview whose bridge answers every switch with `reply`. */
function fakeEditorWebview(reply: Record<string, unknown>) {
  const target = new EventTarget();
  const scripts: string[] = [];
  const webview = Object.assign(target, {
    isConnected: true,
    executeJavaScript: vi.fn(async (code: string) => {
      scripts.push(code);
      return reply;
    }),
  });
  vi.mocked(getPersistentBrowserWebview).mockReturnValue(webview as never);
  return {
    webview,
    /** Payloads POSTed to the bridge's switch route, oldest first. */
    switchPayloads: () =>
      scripts
        .filter((code) => code.includes("/broker/switch"))
        .map((code) => JSON.parse(/const payload = (.*);/.exec(code)?.[1] ?? "null")),
  };
}

async function flushSwitches(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetBrowserEditorInstancesForTests();
  nextBrowserId = 0;
  vi.clearAllMocks();
  vi.mocked(getIsElectron).mockReturnValue(true);
  vi.mocked(navigatePersistentBrowserWebview).mockReturnValue(true);
  vi.mocked(getPersistentBrowserWebview).mockReturnValue(null);
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
    expect(ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo" })).toBeNull();
  });

  it("creates exactly one instance per origin and reuses it", () => {
    const first = ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo" });
    const second = ensureBrowserEditorInstance({
      browserEditorUrl: `${HOST}/some/deep/path`,
      folder: "/other",
    });

    expect(first).not.toBeNull();
    expect(second?.browserId).toBe(first?.browserId);
    // A second browserId is never minted for the same origin.
    expect(createBrowserId).toHaveBeenCalledTimes(1);
    expect(isBrowserEditorInstance(first?.browserId ?? "")).toBe(true);
    expect(second?.url).toContain("other");
    expect(navigatePersistentBrowserWebview).toHaveBeenCalledWith(
      first?.browserId,
      expect.stringContaining("other"),
    );
    // The warm webview is (re-)ensured on both calls.
    expect(ensurePersistentBrowserWebview).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct instances per origin", () => {
    const a = ensureBrowserEditorInstance({ browserEditorUrl: "http://host-a:8765", folder: "/a" });
    const b = ensureBrowserEditorInstance({ browserEditorUrl: "http://host-b:8765", folder: "/b" });
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

    const instance = ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo" });

    expect(instance?.browserId).toBe("current");
    expect(createBrowserId).not.toHaveBeenCalled();
    expect(removeBrowser).toHaveBeenCalledWith("old");
    expect(updateBrowser).toHaveBeenCalledWith("current", {
      url: `${HOST}/?folder=%2Frepo`,
    });
  });
});

describe("workspace mode", () => {
  it("opens the workspace file and switches projects in place, without a reload", async () => {
    const editor = fakeEditorWebview({ ok: true, status: 200, switched: true });
    const instance = ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folder: "/repo-a",
      workspaceFile: WORKSPACE_FILE,
    });
    expect(ensurePersistentBrowserWebview).toHaveBeenCalledWith({
      browserId: instance?.browserId,
      url: `${HOST}/?workspace=${encodeURIComponent(WORKSPACE_FILE)}`,
    });

    ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo-b" });
    await flushSwitches();

    expect(navigatePersistentBrowserWebview).not.toHaveBeenCalled();
    expect(editor.switchPayloads()).toEqual([{ folder: "/repo-b", workspaceFile: WORKSPACE_FILE }]);
  });

  it("selects the current project after every page load", async () => {
    const editor = fakeEditorWebview({ ok: true, status: 200, switched: false });
    ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folder: "/repo-a",
      workspaceFile: WORKSPACE_FILE,
    });

    editor.webview.dispatchEvent(new Event("dom-ready"));
    await flushSwitches();
    ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo-b" });
    await flushSwitches();
    // A reload (load recovery, fallback open) reopens whatever the file held.
    editor.webview.dispatchEvent(new Event("dom-ready"));
    await flushSwitches();

    expect(editor.switchPayloads().map((payload) => payload.folder)).toEqual([
      "/repo-a",
      "/repo-b",
      "/repo-b",
    ]);
  });

  it("falls back to folder mode when the host's bridge can't switch", async () => {
    fakeEditorWebview({ ok: false, status: 404, error: "not found" });
    const instance = ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folder: "/repo-a",
      workspaceFile: WORKSPACE_FILE,
    });
    ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo-b" });
    await flushSwitches();

    expect(instance?.workspaceFile).toBeNull();
    expect(navigatePersistentBrowserWebview).toHaveBeenLastCalledWith(
      instance?.browserId,
      `${HOST}/?folder=%2Frepo-b`,
    );
    // It stays in folder mode even when callers keep supplying the file.
    ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folder: "/repo-c",
      workspaceFile: WORKSPACE_FILE,
    });
    expect(navigatePersistentBrowserWebview).toHaveBeenLastCalledWith(
      instance?.browserId,
      `${HOST}/?folder=%2Frepo-c`,
    );
  });

  it("keeps workspace mode on a transient bridge failure", async () => {
    fakeEditorWebview({ ok: false, error: "Failed to fetch" });
    const instance = ensureBrowserEditorInstance({
      browserEditorUrl: HOST,
      folder: "/repo-a",
      workspaceFile: WORKSPACE_FILE,
    });
    ensureBrowserEditorInstance({ browserEditorUrl: HOST, folder: "/repo-b" });
    await flushSwitches();

    expect(instance?.workspaceFile).toBe(WORKSPACE_FILE);
    expect(navigatePersistentBrowserWebview).not.toHaveBeenCalled();
  });
});

describe("usePreloadBrowserEditor", () => {
  const base = {
    browserEditorUrl: HOST,
    workspaceDirectory: "/repo-a",
    workspaceKey: "server-1:workspace-a",
    homeDirectory: null as string | null,
    isActive: true,
  };

  it("does nothing while the workspace is not active", () => {
    renderHook(() => usePreloadBrowserEditor({ ...base, isActive: false }));
    expect(ensurePersistentBrowserWebview).not.toHaveBeenCalled();
  });

  it("reloads the parked instance into the newly-active folder without a home directory", () => {
    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: base,
    });
    expect(ensurePersistentBrowserWebview).toHaveBeenCalledTimes(1);

    rerender({ ...base, workspaceDirectory: "/repo-b", workspaceKey: "server-1:workspace-b" });
    expect(navigatePersistentBrowserWebview).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.stringContaining("repo-b"),
    );
  });

  it("moves into workspace mode once the host's home is known, and stays there", () => {
    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: base,
    });
    rerender({ ...base, homeDirectory: "/home/u" });
    expect(navigatePersistentBrowserWebview).toHaveBeenLastCalledWith(
      "vscode-web-1",
      `${HOST}/?workspace=${encodeURIComponent(WORKSPACE_FILE)}`,
    );

    // A reconnect clears server_info for a moment: no reload back to folder mode.
    rerender({ ...base, homeDirectory: null });
    rerender({ ...base, homeDirectory: null, workspaceDirectory: "/repo-b" });
    expect(navigatePersistentBrowserWebview).toHaveBeenCalledTimes(1);
  });

  it("navigates via the store when the webview is adopted (not parked)", () => {
    const updateBrowser = vi.fn();
    const requestNavigation = vi.fn();
    vi.mocked(useBrowserStore.getState).mockReturnValue({
      updateBrowser,
      requestNavigation,
    } as never);
    vi.mocked(navigatePersistentBrowserWebview).mockReturnValue(false);
    vi.mocked(getBrowserRecord).mockReturnValue({ browserId: "vscode-web-1" } as never);

    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: base,
    });
    rerender({ ...base, workspaceDirectory: "/repo-b", workspaceKey: "server-1:workspace-b" });

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
        ...base,
        workspaceDirectory: "/repo-b",
        workspaceKey: "server-1:workspace-b",
      }),
    );

    expect(closeTab).not.toHaveBeenCalled();
  });
});
