import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { buildPageDocument, buildPageKitTheme } from "@getpaseo/protocol/page/kit";
import { PAGE_PREVIEW_THEMES } from "@getpaseo/protocol/page/theme";
import { framedPageSource } from "./types";

interface MediaReport {
  probe: "media";
  paused: boolean;
  autoplay: boolean;
  currentTime: number;
  readyState: number;
  playError: string | null;
}

const theme = buildPageKitTheme(PAGE_PREVIEW_THEMES.dark);
const clipUrl = new URL("../../../e2e/support/fixtures/recording.webm", import.meta.url).href;
const mountedFrames: HTMLIFrameElement[] = [];

/**
 * Runs inside the page after the kit. It calls play() on load, the way an agent's page
 * might, then reports once the video reaches `readyEvent`. Autoplay, when allowed, has
 * already started by `canplaythrough`. A "play" message calls play() again and reports.
 */
function probe(readyEvent: "loadedmetadata" | "canplaythrough"): string {
  return `<script>
  var video = document.querySelector("video");
  function report(playError){
    parent.postMessage({ probe: "media", paused: video.paused, autoplay: video.autoplay,
      currentTime: video.currentTime, readyState: video.readyState, playError: playError }, "*");
  }
  var firstPlay = video.play().then(function(){ return null; }, function(error){ return error.name; });
  video.addEventListener(${JSON.stringify(readyEvent)}, function(){ firstPlay.then(report); }, { once: true });
  addEventListener("message", function(event){
    if (event.data !== "play") return;
    video.play().then(function(){ report(null); }, function(error){ report(error.name); });
  });
</script>`;
}

function mountPage(html: string): { frame: HTMLIFrameElement; firstReport: Promise<MediaReport> } {
  const frame = document.createElement("iframe");
  // The sandbox page-frame.web.tsx gives HTML pages.
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.style.width = "480px";
  frame.style.height = "320px";
  const firstReport = nextReport(frame);
  frame.srcdoc = buildPageDocument({ html, theme, bridge: "iframe" });
  document.body.append(frame);
  mountedFrames.push(frame);
  return { frame, firstReport };
}

function nextReport(frame: HTMLIFrameElement): Promise<MediaReport> {
  const { promise, resolve } = Promise.withResolvers<MediaReport>();
  function receive(event: MessageEvent): void {
    if (event.source !== frame.contentWindow || event.data?.probe !== "media") return;
    window.removeEventListener("message", receive);
    resolve(event.data as MediaReport);
  }
  window.addEventListener("message", receive);
  return promise;
}

afterEach(() => {
  for (const frame of mountedFrames.splice(0)) frame.remove();
});

describe("media in an agent page", () => {
  it("shows a video URL as a paused player instead of the autoplaying media document", async () => {
    const source = framedPageSource({ kind: "url", url: clipUrl });
    if (source.kind !== "html") throw new Error("a video URL should become a player page");

    const { firstReport } = mountPage(source.html + probe("loadedmetadata"));
    const state = await firstReport;

    expect(state.readyState).toBeGreaterThanOrEqual(1);
    expect(state).toMatchObject({ paused: true, currentTime: 0, playError: "NotAllowedError" });
  });

  it("keeps an autoplay video paused and refuses play() until the reader interacts", async () => {
    const { frame, firstReport } = mountPage(
      `<video autoplay controls preload="auto" src="${clipUrl}"></video>${probe("canplaythrough")}`,
    );
    const before = await firstReport;
    expect(before).toMatchObject({
      paused: true,
      autoplay: false,
      currentTime: 0,
      playError: "NotAllowedError",
    });

    await userEvent.click(frame);
    const afterClick = nextReport(frame);
    frame.contentWindow?.postMessage("play", "*");
    expect(await afterClick).toMatchObject({ paused: false, playError: null });
  });

  it("leaves URLs that are not video files as URL pages", () => {
    const page = {
      kind: "url",
      url: "http://localhost:8791/pr-reviews/portal-1/review.html",
    } as const;
    expect(framedPageSource(page)).toBe(page);
  });
});
