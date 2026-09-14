/**
 * Turn a History search box string into an FTS5 MATCH query.
 *
 * Bare words become AND-of-prefixes so "warm pool" finds "warming the pool".
 * Quoted text and pasted URLs become phrases so a PR link is one token, not
 * a pile of slashes. A query that is only stopwords returns null — FTS would
 * scan the whole index and the metadata ranker already has nothing to do.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

const TOKEN_RE = /[^\s]+/g;

export function toFtsQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (isPhraseQuery(trimmed)) {
    const inner = stripWrappingQuotes(trimmed);
    if (!inner) return null;
    return quotePhrase(inner);
  }

  const tokens = trimmed.match(TOKEN_RE) ?? [];
  const kept = tokens
    .map((token) => token.replace(/^['"]+|['"]+$/g, ""))
    .filter((token) => token.length > 0)
    .filter((token, _, all) => all.length > 1 || !isStopword(token));

  if (kept.length === 0) return null;

  return kept.map((token) => toPrefixTerm(token)).join(" AND ");
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

function isPhraseQuery(query: string): boolean {
  if (
    (query.startsWith('"') && query.endsWith('"') && query.length >= 2) ||
    (query.startsWith("'") && query.endsWith("'") && query.length >= 2)
  ) {
    return true;
  }
  if (/https?:\/\//i.test(query)) return true;
  if (/github\.com\//i.test(query)) return true;
  if (/\/pull\/\d+/.test(query)) return true;
  return false;
}

function stripWrappingQuotes(query: string): string {
  if (
    (query.startsWith('"') && query.endsWith('"')) ||
    (query.startsWith("'") && query.endsWith("'"))
  ) {
    return query.slice(1, -1).trim();
  }
  return query;
}

function quotePhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function toPrefixTerm(token: string): string {
  const cleaned = token.replace(/[^\p{L}\p{N}.\-_]/gu, "");
  if (!cleaned) {
    return quotePhrase(token);
  }
  const safe = cleaned.replace(/["*():^]/g, "");
  if (!safe) return quotePhrase(token);
  return `${safe}*`;
}
