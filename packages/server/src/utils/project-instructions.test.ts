import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectCommanderInstructions } from "./project-instructions.js";

describe("resolveProjectCommanderInstructions", () => {
  function createTempProject(): { rootPath: string; cleanup: () => void } {
    const rootPath = mkdtempSync(join(tmpdir(), "paseo-test-project-instructions-"));
    return {
      rootPath,
      cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
    };
  }

  it("loads inline instructions from commander.instructions in paseo.json", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(
        join(rootPath, "paseo.json"),
        JSON.stringify({
          commander: {
            instructions:
              "Use opencode-zen/ox-alpha-free model and run npm test before completion.",
          },
        }),
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe(
        "Use opencode-zen/ox-alpha-free model and run npm test before completion.",
      );
    } finally {
      cleanup();
    }
  });

  it("loads instructions from a referenced file in commander.instructions", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(
        join(rootPath, "custom-instructions.md"),
        "# Custom Instructions\n\n- Model: codex/gpt-5.4\n- Always run linter",
      );
      writeFileSync(
        join(rootPath, "paseo.json"),
        JSON.stringify({
          commander: {
            instructions: "./custom-instructions.md",
          },
        }),
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe(
        "# Custom Instructions\n\n- Model: codex/gpt-5.4\n- Always run linter",
      );
    } finally {
      cleanup();
    }
  });

  it("loads instructions from commander.instructionsFile in paseo.json", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      mkdirSync(join(rootPath, "docs"), { recursive: true });
      writeFileSync(
        join(rootPath, "docs", "agent-rules.md"),
        "Follow ASD-STE100 Simplified Technical English.",
      );
      writeFileSync(
        join(rootPath, "paseo.json"),
        JSON.stringify({
          commander: {
            instructionsFile: "docs/agent-rules.md",
          },
        }),
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe("Follow ASD-STE100 Simplified Technical English.");
    } finally {
      cleanup();
    }
  });

  it("loads instructions from top-level commanderInstructions shortcut in paseo.json", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(
        join(rootPath, "paseo.json"),
        JSON.stringify({
          commanderInstructions: "Direct project instructions for the Commander.",
        }),
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe("Direct project instructions for the Commander.");
    } finally {
      cleanup();
    }
  });

  it("falls back to COMMANDER.md in root directory when paseo.json has no instructions", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(join(rootPath, "COMMANDER.md"), "Default root COMMANDER.md instructions.");
      writeFileSync(join(rootPath, "paseo.json"), JSON.stringify({}));

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe("Default root COMMANDER.md instructions.");
    } finally {
      cleanup();
    }
  });

  it("falls back to .paseo/COMMANDER.md when root COMMANDER.md is absent", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      mkdirSync(join(rootPath, ".paseo"), { recursive: true });
      writeFileSync(
        join(rootPath, ".paseo", "COMMANDER.md"),
        "Hidden .paseo/COMMANDER.md instructions.",
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe("Hidden .paseo/COMMANDER.md instructions.");
    } finally {
      cleanup();
    }
  });

  it("falls back to .paseo/commander.md (lowercase) when uppercase is absent", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      mkdirSync(join(rootPath, ".paseo"), { recursive: true });
      writeFileSync(
        join(rootPath, ".paseo", "commander.md"),
        "Lowercase .paseo/commander.md instructions.",
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe("Lowercase .paseo/commander.md instructions.");
    } finally {
      cleanup();
    }
  });

  it("returns null when no instructions or files exist", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null when instruction content is whitespace-only", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(join(rootPath, "COMMANDER.md"), "   \n\t  \n  ");

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("handles corrupt paseo.json gracefully by falling back to COMMANDER.md", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(join(rootPath, "paseo.json"), "{ corrupt json }");
      writeFileSync(join(rootPath, "COMMANDER.md"), "Recovered from COMMANDER.md.");

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBe("Recovered from COMMANDER.md.");
    } finally {
      cleanup();
    }
  });

  it("rejects path traversal outside rootPath", async () => {
    const { rootPath, cleanup } = createTempProject();
    try {
      writeFileSync(
        join(rootPath, "paseo.json"),
        JSON.stringify({
          commander: {
            instructionsFile: "../../outside.md",
          },
        }),
      );

      const instructions = await resolveProjectCommanderInstructions(rootPath);
      expect(instructions).toBeNull();
    } finally {
      cleanup();
    }
  });
});
