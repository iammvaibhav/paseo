/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/components/browser-webview-resident", () => ({
  ensureResidentBrowserWebview: vi.fn(),
  navigateResidentBrowserWebview: vi.fn(() => true),
  removeResidentBrowserWebview: vi.fn(),
}));

let nextBrowserId = 0;
vi.mock("@/stores/browser-store", () => ({
  createBrowserId: vi.fn(() => `vscode-web-${(nextBrowserId += 1)}`),
  getBrowserRecord: vi.fn(() => null),
  useBrowserStore: {
    getState: vi.fn(() => ({ updateBrowser: vi.fn(), requestNavigation: vi.fn() })),
  },
}));

import { getIsElectron } from "@/constants/platform";
import {
  ensureResidentBrowserWebview,
  navigateResidentBrowserWebview,
} from "@/components/browser-webview-resident";
import { createBrowserId, getBrowserRecord, useBrowserStore } from "@/stores/browser-store";
import {
  ensureBrowserEditorInstance,
  resetBrowserEditorInstancesForTests,
  usePreloadBrowserEditor,
} from "./preload-browser-editor";

const HOST = "http://blrofc3:8765";

beforeEach(() => {
  resetBrowserEditorInstancesForTests();
  nextBrowserId = 0;
  vi.clearAllMocks();
  vi.mocked(getIsElectron).mockReturnValue(true);
  vi.mocked(navigateResidentBrowserWebview).mockReturnValue(true);
  vi.mocked(getBrowserRecord).mockReturnValue(null);
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
    // The warm webview is (re-)ensured on both calls.
    expect(ensureResidentBrowserWebview).toHaveBeenCalledTimes(2);
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
});

describe("usePreloadBrowserEditor", () => {
  it("does nothing while the workspace is not active", () => {
    renderHook(() =>
      usePreloadBrowserEditor({
        browserEditorUrl: HOST,
        workspaceDirectory: "/repo-a",
        isActive: false,
      }),
    );
    expect(ensureResidentBrowserWebview).not.toHaveBeenCalled();
  });

  it("re-roots the parked instance to the newly-active workspace folder", () => {
    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: { browserEditorUrl: HOST, workspaceDirectory: "/repo-a", isActive: true },
    });
    expect(ensureResidentBrowserWebview).toHaveBeenCalledTimes(1);

    // Switch to another workspace on the same host → background re-root.
    rerender({ browserEditorUrl: HOST, workspaceDirectory: "/repo-b", isActive: true });
    expect(navigateResidentBrowserWebview).toHaveBeenCalledWith(
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
    vi.mocked(navigateResidentBrowserWebview).mockReturnValue(false);
    vi.mocked(getBrowserRecord).mockReturnValue({ browserId: "vscode-web-1" } as never);

    const { rerender } = renderHook((props) => usePreloadBrowserEditor(props), {
      initialProps: { browserEditorUrl: HOST, workspaceDirectory: "/repo-a", isActive: true },
    });
    rerender({ browserEditorUrl: HOST, workspaceDirectory: "/repo-b", isActive: true });

    expect(requestNavigation).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.stringContaining("repo-b"),
    );
    expect(updateBrowser).toHaveBeenCalledWith(
      "vscode-web-1",
      expect.objectContaining({ url: expect.stringContaining("repo-b") }),
    );
  });
});
