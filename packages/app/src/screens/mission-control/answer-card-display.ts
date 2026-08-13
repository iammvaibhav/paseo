/**
 * Commander tool names a model can echo as literal markup instead of invoking.
 * Mirrors the daemon's COMMANDER_TOOL_ALLOWLIST; kept as a local list because
 * the app must sanitize cards emitted by older daemons too.
 */
const LEAKABLE_TOOL_NAMES = [
  "post_answer",
  "clarify",
  "fleet_create_agent",
  "fleet_send_prompt",
  "fleet_meta",
  "fleet_list_agents",
  "fleet_list_models",
  "fleet_get_agent_activity",
  "fleet_search",
  "fleet_recall",
  "fleet_context",
  "tag_message",
] as const;

const LEAKED_TOOL_TAG_PATTERN = new RegExp(`<\\/?(?:${LEAKABLE_TOOL_NAMES.join("|")})\\b`, "i");

/** True when the text contains a raw tool-call tag rather than prose. */
export function containsLeakedToolMarkup(text: string): boolean {
  return LEAKED_TOOL_TAG_PATTERN.test(text);
}

/**
 * Remove raw tool-call markup so a card never renders XML at the user.
 * Covers every Commander tool, not just post_answer.
 */
export function stripLeakedToolMarkup(text: string): string {
  let out = text;
  for (const name of LEAKABLE_TOOL_NAMES) {
    out = out
      // Paired element: the inner text is tool arguments, not prose.
      .replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, "gi"), " ")
      // Self-closing element.
      .replace(new RegExp(`<${name}\\b[^>]*\\/>`, "gi"), " ")
      // Any stray opening/closing tag left behind.
      .replace(new RegExp(`<\\/?${name}\\b[^>]*>`, "gi"), " ");
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Some model turns echo a tool call as XML into assistant prose, and the
 * synthetic-answer fallback can embed that markup in the body. Prefer
 * structured fields when present; otherwise recover a readable card from
 * leaked markup so the thread never shows raw XML.
 */
export function parseLeakedPostAnswerMarkup(raw: string): {
  headline?: string;
  body?: string;
  fields?: Array<{ label: string; value: string }>;
} | null {
  const text = raw.trim();
  if (!containsLeakedToolMarkup(text)) {
    return null;
  }
  const headlineMatch = text.match(/\bheadline\s*=\s*"([^"]*)"/i);
  const bodyMatch = text.match(/\bbody\s*=\s*"([^"]*)"/i);
  const fieldsMatch = text.match(/\bfields\s*=\s*\[([\s\S]*?)\]/i);
  const fields: Array<{ label: string; value: string }> = [];
  if (fieldsMatch) {
    const pairRe = /\{\s*label\s*=\s*"([^"]*)"\s*,\s*value\s*=\s*"([^"]*)"\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(fieldsMatch[1])) !== null) {
      fields.push({ label: m[1], value: m[2] });
    }
  }
  // No answer-shaped attributes: the markup is some other tool call (a leaked
  // dispatch). Nothing to recover as an answer — the caller strips the tags.
  if (!headlineMatch && !bodyMatch && fields.length === 0) {
    return null;
  }
  return {
    ...(headlineMatch ? { headline: headlineMatch[1] } : {}),
    ...(bodyMatch ? { body: bodyMatch[1] } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

export function resolveAnswerCardDisplay(answer: {
  headline: string;
  body?: string | null;
  fields?: Array<{ label: string; value: string }> | null;
}): {
  headline: string;
  body: string | null;
  fields: Array<{ label: string; value: string }> | null;
} {
  // Parse per field: joining them would fold the headline into a recovered
  // body. Answer-shaped markup wins; anything else is just stripped.
  const leaked =
    parseLeakedPostAnswerMarkup(answer.body ?? "") ?? parseLeakedPostAnswerMarkup(answer.headline);
  const headline = leaked?.headline ?? stripLeakedToolMarkup(answer.headline);
  const body = leaked?.body ?? (answer.body ? stripLeakedToolMarkup(answer.body) : null);
  return {
    headline,
    body: body && body.length > 0 ? body : null,
    fields: answer.fields && answer.fields.length > 0 ? answer.fields : (leaked?.fields ?? null),
  };
}
