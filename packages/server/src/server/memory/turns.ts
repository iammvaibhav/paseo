import { splitAgentModeBlock } from "@getpaseo/protocol/agent-modes";
import type { ExtractedChunk } from "../search/extract.js";
import type { MemoryItem } from "./types.js";

/** One chunk stays under ~1.5k tokens; longer turns are split, each piece keeping the prompt. */
const MAX_CHARS = 6000;
const PROMPT_HEAD = 600;

export interface TurnSource {
  agentId: string;
  agentTitle: string;
  agentName: string | null;
  host: string;
  project: string | null;
}

/**
 * Memory items for an agent's conversation: one per turn, a turn being the user's
 * prompt plus the agent's text replies to it. Tool calls and reasoning are left out
 * (they stay in the per-host transcript index, where exact-identifier search over
 * tool output works best). Ids are `turn:<agentId>:<ord of the prompt>:<piece>`,
 * stable across re-indexing, so re-sending a turn that did not change is a no-op.
 */
export function buildTurnItems(
  source: TurnSource,
  chunks: readonly ExtractedChunk[],
): MemoryItem[] {
  const items: MemoryItem[] = [];
  let prompt = "";
  let replies: string[] = [];
  let firstOrd = 0;
  let ts: number | null = null;
  let lastRole: string | null = null;

  const flush = () => {
    if (!prompt && replies.length === 0) return;
    const ask = splitAgentModeBlock(prompt).body.trim();
    const body = replies.join("\n").trim();
    const head = `User: ${ask}\nAgent: `;
    let pieces: string[];
    if (head.length + body.length <= MAX_CHARS) {
      pieces = [head + body];
    } else {
      const short = `User: ${ask.slice(0, PROMPT_HEAD)}\nAgent: `;
      const room = MAX_CHARS - short.length;
      pieces = [];
      for (let i = 0; i < body.length; i += room) pieces.push(short + body.slice(i, i + room));
    }
    pieces.forEach((text, piece) => {
      items.push({
        id: `turn:${source.agentId}:${firstOrd}:${piece}`,
        kind: "turn",
        title: source.agentTitle,
        text,
        host: source.host,
        agent_id: source.agentId,
        project: source.project,
        ts,
        meta: source.agentName ? { agent_name: source.agentName } : {},
      });
    });
  };

  chunks.forEach((chunk, ord) => {
    if (chunk.role === "user_message") {
      if (lastRole === "user_message") {
        prompt += chunk.text;
      } else {
        flush();
        prompt = chunk.text;
        replies = [];
        firstOrd = ord;
        ts = chunk.ts;
      }
      lastRole = chunk.role;
    } else if (chunk.role === "assistant_message") {
      if (lastRole === "assistant_message" && replies.length > 0) {
        replies[replies.length - 1] += chunk.text;
      } else {
        if (lastRole === null) {
          firstOrd = ord;
          ts = chunk.ts;
        }
        replies.push(chunk.text);
      }
      lastRole = chunk.role;
    }
  });
  flush();
  return items;
}
