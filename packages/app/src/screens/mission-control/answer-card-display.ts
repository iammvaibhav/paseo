/**
 * Some model turns echo the post_answer tool call as XML into assistant prose,
 * and the synthetic-answer fallback can also embed that markup in the body.
 * Prefer structured fields when present; otherwise recover a readable card
 * from leaked markup so the thread never shows raw XML.
 */
export function parseLeakedPostAnswerMarkup(raw: string): {
  headline?: string;
  body?: string;
  fields?: Array<{ label: string; value: string }>;
} | null {
  const text = raw.trim();
  if (!text.includes("<post_answer") && !text.includes("post_answer")) {
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
  const leaked = parseLeakedPostAnswerMarkup(
    [answer.headline, answer.body].filter(Boolean).join("\n"),
  );
  return {
    headline: leaked?.headline ?? answer.headline,
    body: leaked?.body ?? answer.body ?? null,
    fields: answer.fields && answer.fields.length > 0 ? answer.fields : (leaked?.fields ?? null),
  };
}
