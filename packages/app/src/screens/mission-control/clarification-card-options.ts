/**
 * Conventional free-text sentinel options.
 *
 * A Commander clarification that also allows free text sometimes lists a
 * catch-all option like "Other (say what you need)" alongside the real
 * choices. Clicking such an option would submit the literal sentinel string
 * to the Commander instead of letting the user type — so when
 * `allowFreeText` is true we drop these from the clickable option list (the
 * textarea already gives the user a free-text path).
 *
 * Recognition is deliberately narrow: the whole option must reduce to a known
 * sentinel phrase after trimming, lowercasing, collapsing whitespace, and
 * dropping trailing ellipsis/period and parenthetical hint text
 * ("Other (say what you need)" -> "other"). Ordinary options that merely
 * contain a sentinel word — e.g. "Other host" — keep extra words and are
 * preserved. Filtering only ever happens when `allowFreeText` is true.
 */
const FREE_TEXT_SENTINELS: Record<string, true> = {
  other: true,
  "other answer": true,
  "something else": true,
  "type your own": true,
  "type your own answer": true,
  "write your own": true,
  "enter your own": true,
  custom: true,
};

export function isFreeTextSentinelOption(option: string): boolean {
  return (
    FREE_TEXT_SENTINELS[
      option
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/\([^)]*\)/g, "")
        .replace(/[.…]+$/g, "")
        .trim()
    ] === true
  );
}

export function filterClarificationOptions(
  options: readonly string[],
  allowFreeText: boolean,
): string[] {
  if (!allowFreeText) {
    return [...options];
  }
  return options.filter((option) => !isFreeTextSentinelOption(option));
}
