import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@getpaseo/protocol/agent-title-limits";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const MAX_INITIAL_AGENT_TITLE_CHARS = Math.min(60, MAX_EXPLICIT_AGENT_TITLE_CHARS);

/**
 * Deterministic last-resort title for registrations with no explicit title
 * and no usable first prompt line (internal/MCP creates without prompts).
 * Spec 06: registration ALWAYS produces a title — `explicit ??
 * first-prompt-line(60) ?? derived stub` — so the persisted record's title
 * is never null.
 */
export function deriveFallbackAgentTitle(timestamp: Date = new Date()): string {
  return `Agent started ${timestamp.toISOString()}`;
}

function deriveInitialAgentTitle(prompt: string): string | null {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  let candidateLine: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#+\s*(?:verbatim\s*ask|goal|brief|task|instructions|context)\b/i.test(line)) {
      continue;
    }
    if (/^itsaplan ticket moved/i.test(line)) {
      continue;
    }
    if (/^project:\s*\S+/i.test(line) && i + 1 < lines.length && /^ticket:/i.test(lines[i + 1]!)) {
      continue;
    }
    candidateLine = line;
    break;
  }

  if (!candidateLine) {
    candidateLine = lines[0]!;
  }

  let cleaned = candidateLine.replace(/^[>\s"']+|[>\s"']+$/g, "").trim();
  const ticketPrefixMatch =
    /^(?:ticket(?:\s*id)?|issue):\s*([A-Za-z0-9_]+-\d+)\s*[—–-]?\s*(.*)$/i.exec(cleaned);
  if (ticketPrefixMatch) {
    const [, ticketKey, rest] = ticketPrefixMatch;
    cleaned = rest ? `${ticketKey} - ${rest}` : (ticketKey ?? cleaned);
  }

  const normalized = cleaned.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const clamped = normalized.slice(0, MAX_INITIAL_AGENT_TITLE_CHARS).trim();
  return clamped.length > 0 ? clamped : null;
}

export function resolveCreateAgentTitles(options: {
  configTitle?: string | null;
  initialPrompt?: string | null;
}): { explicitTitle: string | null; provisionalTitle: string | null } {
  const explicitTitle =
    typeof options.configTitle === "string" && options.configTitle.trim().length > 0
      ? options.configTitle.trim()
      : null;
  const trimmedPrompt = options.initialPrompt?.trim();
  const provisionalTitle =
    explicitTitle ?? (trimmedPrompt ? deriveInitialAgentTitle(trimmedPrompt) : null);

  return {
    explicitTitle,
    provisionalTitle,
  };
}

export function resolveFirstAgentPromptTitle(firstAgentContext?: FirstAgentContext): string | null {
  return (
    resolveCreateAgentTitles({
      initialPrompt: firstAgentContext?.prompt,
    }).provisionalTitle ?? null
  );
}
