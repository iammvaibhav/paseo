import { beforeEach, describe, expect, it, vi } from "vitest";
import * as residentWebviews from "@/desktop/browser/resident-webviews";
import {
  navigateItsaplanEmbedProject,
  prefetchItsaplanProject,
  prefetchItsaplanProjects,
} from "./itsaplan-webview.electron";

describe("itsaplan-webview navigation and prefetching", () => {
  const mockExecute = vi.fn().mockResolvedValue(true);
  const mockWebview = {
    executeJavaScript: mockExecute,
  } as unknown as HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not execute script if webview is not ready", () => {
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);
    vi.spyOn(residentWebviews, "isResidentBrowserWebviewReady").mockReturnValue(false);

    prefetchItsaplanProject("PASEO");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("executes prefetch script when webview is ready", () => {
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);
    vi.spyOn(residentWebviews, "isResidentBrowserWebviewReady").mockReturnValue(true);

    prefetchItsaplanProject("PASEO");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const script = mockExecute.mock.calls[0]![0];
    expect(script).toContain("prefetchProject");
    expect(script).toContain('"PASEO"');
  });

  it("prefetches multiple projects in sequence", () => {
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);
    vi.spyOn(residentWebviews, "isResidentBrowserWebviewReady").mockReturnValue(true);

    prefetchItsaplanProjects(["PASEO", "AMBIENTAISTA", ""]);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[0]![0]).toContain('"PASEO"');
    expect(mockExecute.mock.calls[1]![0]).toContain('"AMBIENTAISTA"');
  });

  it("executes client-side navigation script for a project key", () => {
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);
    vi.spyOn(residentWebviews, "isResidentBrowserWebviewReady").mockReturnValue(true);

    navigateItsaplanEmbedProject("MKT");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const script = mockExecute.mock.calls[0]![0];
    expect(script).toContain("navigateProject");
    expect(script).toContain('"MKT"');
    expect(script).toContain("pushState");
  });
});
