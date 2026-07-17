import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createBrowserId, useBrowserStore } from "./index";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

describe("browser-store bridge-open channel", () => {
  beforeEach(() => {
    useBrowserStore.setState({
      browsersById: {},
      navigationRequestByBrowserId: {},
      bridgeOpenRequestByBrowserId: {},
    });
  });

  it("creates a record with an explicit browserId", () => {
    const id = useBrowserStore.getState().createBrowser({
      browserId: VALID_ID,
      initialUrl: "http://blrofc3:8765",
      chrome: "embedded",
    });
    expect(id).toBe(VALID_ID);
    const record = useBrowserStore.getState().browsersById[VALID_ID];
    expect(record?.chrome).toBe("embedded");
  });

  it("generates ids that satisfy the browser-id schema", () => {
    // parse() inside createBrowser throws on an invalid id, so a round-trip proves validity.
    expect(() =>
      useBrowserStore.getState().createBrowser({ browserId: createBrowserId() }),
    ).not.toThrow();
  });

  it("records a bridge-open request with incrementing ids and normalized fields", () => {
    const store = useBrowserStore.getState();
    store.requestBridgeOpen(VALID_ID, {
      path: "  /repo/a.ts  ",
      line: 12,
      column: 0,
      fallbackUrl: "http://blrofc3:8765/?folder=%2Frepo",
      targetWorkspaceKey: " server-1:workspace-1 ",
    });
    const first = useBrowserStore.getState().bridgeOpenRequestByBrowserId[VALID_ID];
    expect(first).toEqual({
      path: "/repo/a.ts",
      line: 12,
      column: null, // 0 is not a positive integer
      fallbackUrl: "http://blrofc3:8765/?folder=%2Frepo",
      targetWorkspaceKey: "server-1:workspace-1",
      requestId: 1,
    });

    store.requestBridgeOpen(VALID_ID, { path: "/repo/b.ts" });
    expect(useBrowserStore.getState().bridgeOpenRequestByBrowserId[VALID_ID]?.requestId).toBe(2);
  });

  it("ignores bridge-open requests with a blank path", () => {
    useBrowserStore.getState().requestBridgeOpen(VALID_ID, { path: "   " });
    expect(useBrowserStore.getState().bridgeOpenRequestByBrowserId[VALID_ID]).toBeUndefined();
  });

  it("clears a bridge-open request only for a matching requestId", () => {
    const store = useBrowserStore.getState();
    store.requestBridgeOpen(VALID_ID, { path: "/repo/a.ts" });
    store.clearBridgeOpenRequest(VALID_ID, 999);
    expect(useBrowserStore.getState().bridgeOpenRequestByBrowserId[VALID_ID]).toBeDefined();
    store.clearBridgeOpenRequest(VALID_ID, 1);
    expect(useBrowserStore.getState().bridgeOpenRequestByBrowserId[VALID_ID]).toBeUndefined();
  });

  it("drops a pending bridge-open request when the browser is removed", () => {
    const store = useBrowserStore.getState();
    store.createBrowser({ browserId: VALID_ID, chrome: "embedded" });
    store.requestBridgeOpen(VALID_ID, { path: "/repo/a.ts" });
    store.removeBrowser(VALID_ID);
    expect(useBrowserStore.getState().bridgeOpenRequestByBrowserId[VALID_ID]).toBeUndefined();
    expect(useBrowserStore.getState().browsersById[VALID_ID]).toBeUndefined();
  });
});
