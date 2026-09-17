import React, { type ReactNode } from "react";
import type { ASTNode } from "react-native-markdown-display";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { isMermaidFenceLanguage } from "@/components/mermaid-fence";
import { InteractiveChart } from "@/components/interactive-chart";
import { resolveChartFenceLanguage } from "@/components/interactive-chart-fence";

/**
 * Fences that render as a live component instead of highlighted source.
 *
 * Every markdown rule table that wants rich fences calls this, so a new fence
 * type is registered once. The assistant timeline builds its own rule table and
 * passes it to `MarkdownRenderer`, which means `createSharedMarkdownRules` is
 * bypassed there — registering a fence in only one of them silently does
 * nothing in chat.
 *
 * Returns `null` when the fence should fall through to the caller's normal code
 * block, since each caller renders source differently.
 */
export function renderRichFence(node: ASTNode): ReactNode | null {
  if (isMermaidFenceLanguage(node.sourceInfo)) {
    return <MermaidDiagram key={node.key} code={node.content} />;
  }
  const chartLanguage = resolveChartFenceLanguage(node.sourceInfo);
  if (chartLanguage) {
    return <InteractiveChart key={node.key} code={node.content} language={chartLanguage} />;
  }
  return null;
}
