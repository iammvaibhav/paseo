import type { StreamItem, TimelinePosition } from "@/types/stream";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

export type StreamNeighborRelation = "above" | "below";

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const item = input.items[input.startIndex];
  if (item?.kind !== "assistant_message") {
    return undefined;
  }
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(item.messageId ? { boundaryMessageId: item.messageId } : {}),
    };
  }
  return item.messageId ? { boundaryMessageId: item.messageId } : undefined;
}

/**
 * Walks above the turn start to the preceding user message. When several user
 * messages are consecutive, returns the first of that group so jump-to-prompt
 * lands at the top of the user turn.
 */
export function resolvePrecedingUserMessage(input: {
  items: readonly StreamItem[];
  startIndex: number;
  getNeighborIndex: (index: number, relation: StreamNeighborRelation) => number;
}): Extract<StreamItem, { kind: "user_message" }> | undefined {
  let index = input.getNeighborIndex(input.startIndex, "above");
  let found: Extract<StreamItem, { kind: "user_message" }> | undefined;

  while (index >= 0 && index < input.items.length) {
    const item = input.items[index];
    if (!item) {
      break;
    }
    if (item.kind === "user_message") {
      found = item;
      index = input.getNeighborIndex(index, "above");
      continue;
    }
    if (found) {
      break;
    }
    index = input.getNeighborIndex(index, "above");
  }

  return found;
}
