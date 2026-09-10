/** Discrete sizes offered by the Agent Grid toolbar; Settings still accepts any px in range. */
export const AGENT_GRID_FONT_SIZE_OPTIONS = [10, 12, 14, 15, 16, 18, 21] as const;

/**
 * CSS zoom that makes tile transcripts render at `agentGridFontSize` while the
 * rest of the app keeps using `contentFontSize`.
 */
export function resolveAgentGridZoom(agentGridFontSize: number, contentFontSize: number): number {
  const content = Math.max(1, contentFontSize);
  return agentGridFontSize / content;
}
