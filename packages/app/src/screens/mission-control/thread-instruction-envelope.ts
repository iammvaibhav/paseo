/**
 * Busy Commander instruction envelopes (mailbox.ts): when the Commander is
 * mid-turn, the daemon steers a user/voice instruction into the running turn
 * wrapped in an ack-and-fold envelope —
 *
 *   New instruction (#12). Acknowledge it in one line, fold it into your open
 *   work, prioritize user-facing asks, then continue.
 *
 *   Open instructions:
 *   - #12: deploy the fleet to staging
 *   - #8: review the soak run
 *
 *   Possibly related (auto-recall):
 *   - staging box is provisioned [paseo-fleet-dev]
 *
 * The provider records the whole envelope as the commander's user_message, so
 * without intervention normal mode shows the machinery verbatim as a user
 * bubble. These helpers are pure: extract the instruction text the envelope
 * carries (the `- #N: …` ledger row for the envelope's own id), failing
 * closed to the raw text for any other shape (genuine user prose that merely
 * starts with "New instruction" must never be rewritten).
 */

const INSTRUCTION_HEADER_PATTERN = /^New instruction \((#\d+)\)/;
const LEDGER_HEADER = "Open instructions:";
// Ledger rows are `- #12: <one-line text>`; the daemon normalizes the
// instruction text to a single line, so the row text is the whole row.
const LEDGER_ROW_PATTERN = /^-\s*(#\d+):\s*(.+)$/;

/**
 * Extracts the current instruction's ledger text from a busy Commander
 * instruction envelope, or null when `text` is not one (unknown shape —
 * callers fail closed to the raw user text).
 *
 * Matches exactly the `- #N: …` ledger row whose id equals the envelope's own
 * `New instruction (#N)` id; a different row id (`#12` vs `#1`) never matches.
 */
export function extractBusyInstructionText(text: string): string | null {
  const header = text.trimStart().match(INSTRUCTION_HEADER_PATTERN);
  if (!header) {
    return null;
  }
  const instructionId = header[1];
  let inLedger = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!inLedger) {
      if (line === LEDGER_HEADER) {
        inLedger = true;
      }
      continue;
    }
    if (line.length === 0) {
      continue;
    }
    const row = LEDGER_ROW_PATTERN.exec(line);
    if (!row) {
      // First non-ledger line (the auto-recall block, trailing prose, …)
      // ends the ledger block.
      break;
    }
    if (row[1] === instructionId) {
      return row[2];
    }
  }
  return null;
}

/**
 * The text a Commander user_message row renders in the given mode. Normal
 * mode collapses busy `New instruction (#N)` envelopes to the instruction
 * text their ledger row carries; verbose keeps the full debug envelope.
 */
export function commanderUserMessageText(text: string, verbose: boolean): string {
  if (!verbose) {
    const instructionText = extractBusyInstructionText(text);
    if (instructionText !== null) {
      return instructionText;
    }
  }
  return text;
}
