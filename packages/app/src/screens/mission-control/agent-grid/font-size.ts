/** Discrete sizes offered by the Agent Grid toolbar; Settings still accepts any px in range. */
export const AGENT_GRID_FONT_SIZE_OPTIONS = [10, 12, 14, 15, 16, 18, 21] as const;

/**
 * CSS zoom calculation that previously scaled tile transcripts.
 *
 * Retained for backwards compatibility with tests and callers; Agent Grid tiles
 * now render directly at standard scale without CSS zoom wrappers so UserMessage
 * bubble padding and layout insets match the workspace full pane.
 */
export function resolveAgentGridZoom(agentGridFontSize: number, contentFontSize: number): number {
  const content = Math.max(1, contentFontSize);
  return agentGridFontSize / content;
}
