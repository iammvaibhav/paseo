import { describe, expect, it } from "vitest";
import {
  commanderUserMessageText,
  extractBusyInstructionText,
} from "./thread-instruction-envelope";

// The daemon's busy-steer envelope (mailbox.ts): header line, the open
// instruction ledger, and — when within budget — the auto-recall block.
const BUSY_ENVELOPE = [
  "New instruction (#12). Acknowledge it in one line, fold it into your open work, prioritize user-facing asks, then continue.",
  "",
  "Open instructions:",
  "- #12: deploy the fleet to staging",
  "- #8: review the soak run",
  "",
  "Possibly related (auto-recall):",
  "- staging box is provisioned [paseo-fleet-dev]",
].join("\n");

describe("extractBusyInstructionText", () => {
  it("extracts the ledger text for the envelope's own instruction id", () => {
    expect(extractBusyInstructionText(BUSY_ENVELOPE)).toBe("deploy the fleet to staging");
  });

  it("matches the exact `- #N: …` ledger row, never a different open row", () => {
    // The envelope's id is #8 — the row for #12 must not win.
    const envelope = BUSY_ENVELOPE.replace("New instruction (#12)", "New instruction (#8)");
    expect(extractBusyInstructionText(envelope)).toBe("review the soak run");
  });

  it("distinguishes #1 from #12 rows (prefix ids never match)", () => {
    const envelope = [
      "New instruction (#1). Acknowledge it in one line.",
      "",
      "Open instructions:",
      "- #1: first task",
      "- #12: twelfth task",
    ].join("\n");
    expect(extractBusyInstructionText(envelope)).toBe("first task");

    const twelfth = envelope.replace("New instruction (#1)", "New instruction (#12)");
    expect(extractBusyInstructionText(twelfth)).toBe("twelfth task");
  });

  it("extracts from a minimal envelope with no auto-recall block", () => {
    const envelope = [
      "New instruction (#3). Acknowledge it in one line.",
      "",
      "Open instructions:",
      "- #3: is staging ready?",
    ].join("\n");
    expect(extractBusyInstructionText(envelope)).toBe("is staging ready?");
  });

  it("fails closed (null) for plain user text that is not an envelope", () => {
    expect(extractBusyInstructionText("deploy the fleet to staging")).toBeNull();
    expect(extractBusyInstructionText("New instruction: deploy the fleet")).toBeNull();
  });

  it("fails closed when the envelope's id has no ledger row", () => {
    const envelope = [
      "New instruction (#9). Acknowledge it in one line.",
      "",
      "Open instructions:",
      "- #8: review the soak run",
    ].join("\n");
    expect(extractBusyInstructionText(envelope)).toBeNull();
  });

  it("fails closed when the ledger block is missing", () => {
    const envelope = [
      "New instruction (#1). Acknowledge it in one line, then continue.",
      "",
      "Possibly related (auto-recall):",
      "- something [paseo-fleet-dev]",
    ].join("\n");
    expect(extractBusyInstructionText(envelope)).toBeNull();
  });

  it("fails closed when a ledger-shaped line appears without the envelope header", () => {
    const envelope = ["Open instructions:", "- #1: deploy the fleet to staging"].join("\n");
    expect(extractBusyInstructionText(envelope)).toBeNull();
  });
});

describe("commanderUserMessageText", () => {
  it("collapses a busy instruction envelope to the instruction text in normal mode", () => {
    expect(commanderUserMessageText(BUSY_ENVELOPE, false)).toBe("deploy the fleet to staging");
  });

  it("keeps the full debug envelope verbatim in verbose mode", () => {
    expect(commanderUserMessageText(BUSY_ENVELOPE, true)).toBe(BUSY_ENVELOPE);
  });

  it("passes plain user text through unchanged in both modes", () => {
    expect(commanderUserMessageText("deploy the fleet to staging", false)).toBe(
      "deploy the fleet to staging",
    );
    expect(commanderUserMessageText("deploy the fleet to staging", true)).toBe(
      "deploy the fleet to staging",
    );
  });

  it("passes an unknown envelope shape through unchanged (fail closed)", () => {
    const odd = "New instruction (#1) — just a note about task numbering";
    expect(commanderUserMessageText(odd, false)).toBe(odd);
  });
});
