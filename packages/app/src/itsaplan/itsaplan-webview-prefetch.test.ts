import { beforeEach, describe, expect, it, vi } from "vitest";
import * as residentWebviews from "@/desktop/browser/resident-webviews";
import {
  navigateItsaplanEmbedProject,
  prefetchItsaplanAllProjects,
  prefetchItsaplanProject,
  prefetchItsaplanProjects,
  warmItsaplanEmbed,
} from "./itsaplan-webview.electron";

describe("itsaplan-webview navigation and prefetching", () => {
  const mockExecute = vi.fn().mockResolvedValue("bridge");
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
    expect(script).toContain('"no-bridge"');
  });

  it("asks the guest to prefetch every project", () => {
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);
    vi.spyOn(residentWebviews, "isResidentBrowserWebviewReady").mockReturnValue(true);

    prefetchItsaplanAllProjects();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const script = mockExecute.mock.calls[0]![0];
    expect(script).toContain("prefetchAllProjects");
    expect(script).toContain("paseo:prefetch-all-projects");
  });

  it("queues project navigation until the guest is ready", () => {
    const ready = vi
      .spyOn(residentWebviews, "isResidentBrowserWebviewReady")
      .mockReturnValue(false);
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);

    navigateItsaplanEmbedProject("AMBIENTAISTA");
    expect(mockExecute).not.toHaveBeenCalled();

    ready.mockReturnValue(true);
    navigateItsaplanEmbedProject("AMBIENTAISTA");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0]![0]).toContain('"AMBIENTAISTA"');
  });

  it("reloads the guest when it reports no bridge, so the project still changes", async () => {
    vi.spyOn(residentWebviews, "getResidentBrowserWebview").mockReturnValue(mockWebview);
    vi.spyOn(residentWebviews, "isResidentBrowserWebviewReady").mockReturnValue(true);
    vi.spyOn(residentWebviews, "ensurePersistentBrowserWebview").mockReturnValue(mockWebview);
    const navigate = vi
      .spyOn(residentWebviews, "navigatePersistentBrowserWebview")
      .mockReturnValue(true);
    mockExecute.mockResolvedValueOnce("no-bridge");

    warmItsaplanEmbed("http://iammvaibhav:3001");
    navigateItsaplanEmbedProject("BREEZEAPI");
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith(
      "itsaplan-embed",
      "http://iammvaibhav:3001/project/BREEZEAPI",
    );
  });
});
