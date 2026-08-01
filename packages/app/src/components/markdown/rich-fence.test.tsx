import { isValidElement } from "react";
import { describe, expect, test } from "vitest";
import type { ASTNode } from "react-native-markdown-display";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { InteractiveChart } from "@/components/interactive-chart";
import { renderRichFence } from "./rich-fence";

function fenceNode(sourceInfo: string, content = "{}"): ASTNode {
  return {
    type: "fence",
    sourceType: "fence",
    key: "fence-1",
    content,
    sourceInfo,
    markup: "```",
    tokenIndex: 0,
    index: 0,
    attributes: {},
    children: [],
  };
}

describe("renderRichFence", () => {
  test("renders mermaid fences as a diagram", () => {
    const rendered = renderRichFence(fenceNode("mermaid", "graph LR\nA-->B"));
    expect(isValidElement(rendered) && rendered.type).toBe(MermaidDiagram);
  });

  test("renders every chart fence as an interactive chart", () => {
    for (const language of ["flint", "echarts", "vegalite", "plotly"]) {
      const rendered = renderRichFence(fenceNode(language));
      expect(isValidElement(rendered) && rendered.type).toBe(InteractiveChart);
    }
  });

  test("passes the resolved language through so the engine can be picked", () => {
    const rendered = renderRichFence(fenceNode("vega-lite"));
    expect(isValidElement(rendered) && rendered.props).toMatchObject({ language: "vegalite" });
  });

  test("falls through for fences the caller should render as source", () => {
    for (const language of ["ts", "json", "chartjs", ""]) {
      expect(renderRichFence(fenceNode(language))).toBeNull();
    }
  });
});
