import { describe, expect, it } from "vitest";
import type { AgentSlashCommand } from "@/hooks/use-agent-commands-query";
import { isOutOfBandCommandDraft, parseLeadingSlashCommandName } from "./out-of-band-command";

const commands: AgentSlashCommand[] = [
  { name: "steer", description: "Steer the active OMP turn", argumentHint: "<message>" },
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "",
    delivery: "out_of_band",
  },
  {
    name: "follow-up",
    description: "Queue a follow-up message for OMP",
    argumentHint: "<message>",
    delivery: "out_of_band",
  },
  { name: "research", description: "Research a topic", argumentHint: "", kind: "skill" },
];

const steerCommands: AgentSlashCommand[] = commands.map((command) =>
  command.name === "steer" ? { ...command, delivery: "out_of_band" } : command,
);

describe("parseLeadingSlashCommandName", () => {
  it("reads the command name ahead of its arguments", () => {
    expect(parseLeadingSlashCommandName("/steer stop sleeping")).toBe("steer");
    expect(parseLeadingSlashCommandName("  /Steer  ")).toBe("steer");
    expect(parseLeadingSlashCommandName("/follow-up look at tests")).toBe("follow-up");
  });

  it("rejects drafts that are not command invocations", () => {
    expect(parseLeadingSlashCommandName("steer this")).toBeNull();
    expect(parseLeadingSlashCommandName("/")).toBeNull();
    expect(parseLeadingSlashCommandName("use /steer to redirect")).toBeNull();
    expect(parseLeadingSlashCommandName("/path/to/file check this")).toBeNull();
  });
});

describe("isOutOfBandCommandDraft", () => {
  it("matches commands the provider declared as out of band", () => {
    expect(
      isOutOfBandCommandDraft({
        text: "/steer run the printf instead",
        hasAttachments: false,
        commands: steerCommands,
      }),
    ).toBe(true);
    expect(isOutOfBandCommandDraft({ text: "/compact", hasAttachments: false, commands })).toBe(
      true,
    );
  });

  it("treats turn commands and plain messages as turns", () => {
    expect(
      isOutOfBandCommandDraft({ text: "/research zod", hasAttachments: false, commands }),
    ).toBe(false);
    expect(isOutOfBandCommandDraft({ text: "keep going", hasAttachments: false, commands })).toBe(
      false,
    );
  });

  it("falls back to a turn when the daemon does not report delivery", () => {
    expect(
      isOutOfBandCommandDraft({ text: "/steer redirect", hasAttachments: false, commands }),
    ).toBe(false);
  });

  it("falls back to a turn when attachments force a structured prompt", () => {
    expect(
      isOutOfBandCommandDraft({
        text: "/steer look at this",
        hasAttachments: true,
        commands: steerCommands,
      }),
    ).toBe(false);
  });
});
