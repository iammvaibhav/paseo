import { describe, expect, test } from "vitest";
import { resolveChartFenceLanguage } from "./interactive-chart-fence";

describe("resolveChartFenceLanguage", () => {
  test("resolves each renderable chart language", () => {
    expect(resolveChartFenceLanguage("flint")).toBe("flint");
    expect(resolveChartFenceLanguage("echarts")).toBe("echarts");
    expect(resolveChartFenceLanguage("vegalite")).toBe("vegalite");
    expect(resolveChartFenceLanguage("plotly")).toBe("plotly");
  });

  test("accepts the hyphenated vega-lite spelling", () => {
    expect(resolveChartFenceLanguage("vega-lite")).toBe("vegalite");
  });

  test("is case and dot insensitive", () => {
    expect(resolveChartFenceLanguage("ECharts")).toBe("echarts");
    expect(resolveChartFenceLanguage(".flint")).toBe("flint");
  });

  test("reads only the first token of the fence info string", () => {
    expect(resolveChartFenceLanguage("echarts title=Revenue")).toBe("echarts");
  });

  test("leaves non-chart fences as source", () => {
    for (const info of ["ts", "json", "mermaid", "chartjs", "vega"]) {
      expect(resolveChartFenceLanguage(info)).toBeNull();
    }
  });

  test("treats missing or blank info as not a chart", () => {
    expect(resolveChartFenceLanguage(null)).toBeNull();
    expect(resolveChartFenceLanguage(undefined)).toBeNull();
    expect(resolveChartFenceLanguage("   ")).toBeNull();
  });
});
