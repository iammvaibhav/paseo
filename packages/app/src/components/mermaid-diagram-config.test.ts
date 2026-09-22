import { describe, expect, it } from "vitest";
import { MERMAID_FALLBACK_FONT_FAMILY, createMermaidConfig } from "./mermaid-diagram-config";

describe("createMermaidConfig", () => {
  it("never leaves the label font relative to where the SVG is inserted", () => {
    // Mermaid measures labels under <body> (no font, so Times) and we paint the SVG
    // inside a react-native-web Text subtree (its own sans stack). A relative family
    // measures in one font and paints in another, and every label is clipped.
    for (const fontFamily of [undefined, "", "   "]) {
      const config = createMermaidConfig({ fontFamily });
      expect(config.fontFamily).toBe(MERMAID_FALLBACK_FONT_FAMILY);
      expect(config.themeVariables?.fontFamily).toBe(MERMAID_FALLBACK_FONT_FAMILY);
    }
  });

  it("passes the theme font through when one is supplied", () => {
    const config = createMermaidConfig({ fontFamily: "Inter, sans-serif" });
    expect(config.fontFamily).toBe("Inter, sans-serif");
    expect(config.themeVariables?.fontFamily).toBe("Inter, sans-serif");
  });

  it("omits colors it was not given rather than handing mermaid a keyword", () => {
    // mermaid runs every theme color through a parser that throws on keywords such
    // as "inherit", so an unset color has to be absent, not relative.
    const themeVariables = createMermaidConfig({}).themeVariables ?? {};
    expect(Object.keys(themeVariables)).toEqual(["fontFamily"]);
  });

  it("falls back to the card surface for node and cluster fills", () => {
    const { themeVariables } = createMermaidConfig({ backgroundColor: "#272A29" });
    expect(themeVariables).toMatchObject({
      background: "#272A29",
      mainBkg: "#272A29",
      clusterBkg: "#272A29",
      edgeLabelBackground: "#272A29",
    });
  });

  it("keeps node fills and borders distinct from the card when given", () => {
    const { themeVariables } = createMermaidConfig({
      backgroundColor: "#272A29",
      nodeBackgroundColor: "#434645",
      nodeBorderColor: "#595B5B",
      clusterBackgroundColor: "#1E2120",
      mutedColor: "#A1A5A4",
    });
    expect(themeVariables).toMatchObject({
      mainBkg: "#434645",
      nodeBorder: "#595B5B",
      clusterBorder: "#595B5B",
      clusterBkg: "#1E2120",
      lineColor: "#A1A5A4",
      edgeLabelBackground: "#272A29",
    });
  });

  it("selects the mermaid theme from the color scheme", () => {
    expect(createMermaidConfig({ colorScheme: "light" }).theme).toBe("default");
    expect(createMermaidConfig({ colorScheme: "dark" }).theme).toBe("dark");
    expect(createMermaidConfig({}).theme).toBe("dark");
  });
});
