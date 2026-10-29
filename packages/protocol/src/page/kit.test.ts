import { describe, expect, it } from "vitest";
import { buildPageDocument, buildPageKitTheme, parsePageFrameMessage } from "./kit.js";
import { PAGE_PREVIEW_THEMES, recolorChartSpec } from "./theme.js";

const theme = buildPageKitTheme(PAGE_PREVIEW_THEMES.dark);

describe("buildPageDocument", () => {
  it("puts the kit first in an existing head so the page's own styles win", () => {
    const doc = buildPageDocument({
      html: "<!doctype html><html><head><style>body{color:red}</style></head><body>x</body></html>",
      theme,
      bridge: "iframe",
    });
    expect(doc.indexOf('id="paseo-kit"')).toBeLessThan(doc.indexOf("body{color:red}"));
    expect(doc.match(/<head>/g)).toHaveLength(1);
  });

  it("wraps a fragment in a full document", () => {
    const doc = buildPageDocument({ html: "<p>hi</p>", theme, bridge: "webview" });
    expect(doc).toMatch(/^<!doctype html><html><head>.*<\/head><body><p>hi<\/p><\/body><\/html>$/s);
  });

  it("keeps a theme value from closing the kit style or script", () => {
    const hostile = buildPageKitTheme({
      ...PAGE_PREVIEW_THEMES.dark,
      fontUi: "</style></script><script>alert(1)</script>",
    });
    const doc = buildPageDocument({ html: "<p>x</p>", theme: hostile, bridge: "iframe" });
    expect(doc.match(/<\/style>/g)).toHaveLength(1);
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("parsePageFrameMessage", () => {
  it("accepts only http(s) URLs for the open message", () => {
    expect(
      parsePageFrameMessage({ source: "paseo-page", type: "open", url: "https://example.com" }),
    ).toEqual({ source: "paseo-page", type: "open", url: "https://example.com" });
    expect(
      parsePageFrameMessage({ source: "paseo-page", type: "open", url: "javascript:alert(1)" }),
    ).toBeNull();
    expect(parsePageFrameMessage({ source: "other", type: "ready" })).toBeNull();
  });
});

describe("recolorChartSpec", () => {
  it("swaps library default colors and Flint's default Vega scheme for the theme palette", () => {
    const palette = ["#111111", "#222222"];
    const spec = {
      color: ["#5470c6", "#91cc75", "#fac858"],
      series: [{ itemStyle: { color: "#5470C6" } }, { itemStyle: { color: "#123456" } }],
      encoding: { color: { scale: { scheme: "tableau10" } } },
    };
    expect(recolorChartSpec(spec, palette)).toEqual({
      color: ["#111111", "#222222", "#111111"],
      series: [{ itemStyle: { color: "#111111" } }, { itemStyle: { color: "#123456" } }],
      encoding: { color: { scale: { range: palette } } },
    });
  });
});
