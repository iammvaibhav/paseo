import type { AgentSlashCommand } from "@/hooks/use-agent-commands-query";

/**
 * Leading slash command in a draft, or null when the draft is not a command
 * invocation. Mirrors the provider-side parse (see
 * `OmpAgentSession.parseSlashCommandInput`) so the client and the daemon agree
 * on what counts as a command.
 */
export function parseLeadingSlashCommandName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length <= 1) {
    return null;
  }
  const withoutPrefix = trimmed.slice(1);
  const firstWhitespaceIdx = withoutPrefix.search(/\s/);
  const commandName =
    firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
  if (!commandName || commandName.includes("/")) {
    return null;
  }
  return commandName.toLowerCase();
}

/**
 * True when the draft invokes a command the provider runs against the live
 * session instead of as a turn (OMP `/steer`, `/compact`, Codex `/goal`, …).
 *
 * Those commands must never enter the composer queue: the daemon executes them
 * out of band without canceling the active turn, so queueing one delivers it
 * after the turn it was supposed to affect. Attachments force a structured
 * prompt, which providers refuse to handle out of band, so a draft carrying
 * attachments is always a turn.
 */
export function isOutOfBandCommandDraft(input: {
  text: string;
  hasAttachments: boolean;
  commands: readonly AgentSlashCommand[];
}): boolean {
  if (input.hasAttachments) {
    return false;
  }
  const name = parseLeadingSlashCommandName(input.text);
  if (!name) {
    return false;
  }
  return input.commands.some(
    (command) => command.delivery === "out_of_band" && command.name.toLowerCase() === name,
  );
}
