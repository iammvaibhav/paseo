import { describe, expect, test } from "vitest";
import {
  applyChartRows,
  assertWorkspaceRelativePath,
  findChartDataUrl,
  parseChartRows,
} from "./chart-data-source";

const encode = (text: string) => new TextEncoder().encode(text);

describe("assertWorkspaceRelativePath", () => {
  test("accepts workspace-relative paths and strips a leading ./", () => {
    expect(assertWorkspaceRelativePath("data/prices.csv")).toBe("data/prices.csv");
    expect(assertWorkspaceRelativePath("./data/prices.csv")).toBe("data/prices.csv");
    expect(assertWorkspaceRelativePath("  data/prices.csv  ")).toBe("data/prices.csv");
  });

  test("rejects absolute paths", () => {
    expect(() => assertWorkspaceRelativePath("/etc/passwd")).toThrow(/workspace-relative/);
    expect(() => assertWorkspaceRelativePath("C:\\secrets.csv")).toThrow(/workspace-relative/);
  });

  test("rejects traversal out of the workspace", () => {
    expect(() => assertWorkspaceRelativePath("../../etc/passwd")).toThrow(/traverse/);
    expect(() => assertWorkspaceRelativePath("data/../../out.csv")).toThrow(/traverse/);
    expect(() => assertWorkspaceRelativePath("data\\..\\..\\out.csv")).toThrow(/traverse/);
  });

  test("rejects remote URLs so a chart cannot make the app fetch", () => {
    for (const url of [
      "https://example.com/a.csv",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ]) {
      expect(() => assertWorkspaceRelativePath(url)).toThrow(/Remote chart data/);
    }
  });

  test("rejects an empty path", () => {
    expect(() => assertWorkspaceRelativePath("   ")).toThrow(/empty/);
  });

  test("allows a legitimate path that merely contains dots", () => {
    expect(assertWorkspaceRelativePath("data/2026..2027/prices.csv")).toBe(
      "data/2026..2027/prices.csv",
    );
  });
});

describe("findChartDataUrl", () => {
  test("reads data.url for the spec languages that define it", () => {
    const spec = { data: { url: "a.csv" } };
    expect(findChartDataUrl(spec, "flint")).toBe("a.csv");
    expect(findChartDataUrl(spec, "vegalite")).toBe("a.csv");
  });

  test("reads dataset.url for echarts", () => {
    expect(findChartDataUrl({ dataset: { url: "a.csv" } }, "echarts")).toBe("a.csv");
  });

  test("returns null for inline data and for plotly", () => {
    expect(findChartDataUrl({ data: { values: [{ a: 1 }] } }, "flint")).toBeNull();
    expect(findChartDataUrl({ data: [{ x: [1] }] }, "plotly")).toBeNull();
    expect(findChartDataUrl({}, "echarts")).toBeNull();
  });
});

describe("applyChartRows", () => {
  test("replaces the reference with rows and keeps sibling keys", () => {
    const applied = applyChartRows(
      { data: { url: "a.csv", name: "prices" }, chart_spec: { chartType: "Line Chart" } },
      "flint",
      [{ a: 1 }],
    );
    expect(applied.data).toEqual({ name: "prices", values: [{ a: 1 }] });
    expect(applied.chart_spec).toEqual({ chartType: "Line Chart" });
  });

  test("targets the echarts dataset slot", () => {
    const applied = applyChartRows({ dataset: { url: "a.csv" } }, "echarts", [{ a: 1 }]);
    expect(applied.dataset).toEqual({ source: [{ a: 1 }] });
  });
});

describe("parseChartRows", () => {
  test("parses csv and coerces numeric columns", () => {
    const rows = parseChartRows(encode("date,close\n2026-07-01,220.5\n2026-07-02,223.5"), "a.csv");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.close).toBe(220.5);
    expect(typeof rows[0]?.close).toBe("number");
  });

  test("parses tsv", () => {
    const rows = parseChartRows(encode("a\tb\n1\t2"), "a.tsv");
    expect(rows[0]).toMatchObject({ a: 1, b: 2 });
  });

  test("parses a json array", () => {
    const rows = parseChartRows(encode('[{"a":1},{"a":2}]'), "a.json");
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("rejects json that is not an array of rows", () => {
    expect(() => parseChartRows(encode('{"a":1}'), "a.json")).toThrow(/array of row objects/);
    expect(() => parseChartRows(encode("not json"), "a.json")).toThrow(/not valid JSON/);
  });

  test("rejects unsupported extensions", () => {
    expect(() => parseChartRows(encode("x"), "a.parquet")).toThrow(/supported types/);
    expect(() => parseChartRows(encode("x"), "noext")).toThrow(/supported types/);
  });
});
