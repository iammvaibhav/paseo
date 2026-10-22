import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { PaseoConfigSchema } from "@getpaseo/protocol/paseo-config-schema";
import { readPaseoConfigJson } from "./paseo-config-file.js";

const DEFAULT_INSTRUCTION_FILENAMES = [
  "COMMANDER.md",
  ".paseo/COMMANDER.md",
  ".paseo/commander.md",
  "commander.md",
];

function readProjectFileContent(rootPath: string, relativeOrSubPath: string): string | null {
  try {
    const resolved = resolve(rootPath, relativeOrSubPath);
    const rel = relative(rootPath, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return null;
    }
    if (!existsSync(resolved)) {
      return null;
    }
    const content = readFileSync(resolved, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function resolveInstructionsFromPaseoConfig(rootPath: string): string | null {
  try {
    const json = readPaseoConfigJson(rootPath);
    if (json === null || typeof json !== "object") {
      return null;
    }
    const parsed = PaseoConfigSchema.safeParse(json);
    if (!parsed.success) {
      return null;
    }
    const config = parsed.data;

    // 1. Check commander.instructionsFile
    if (typeof config.commander?.instructionsFile === "string") {
      const fileContent = readProjectFileContent(
        rootPath,
        config.commander.instructionsFile.trim(),
      );
      if (fileContent !== null) {
        return fileContent;
      }
    }

    // 2. Check commander.instructions or commanderInstructions
    const direct = config.commander?.instructions ?? config.commanderInstructions;
    if (typeof direct === "string" && direct.trim().length > 0) {
      const trimmed = direct.trim();
      const fileContent = readProjectFileContent(rootPath, trimmed);
      return fileContent !== null ? fileContent : trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve project-level instructions for the Commander from a project's root path.
 *
 * Checks in order:
 * 1. `paseo.json` -> `commander.instructionsFile` (file path)
 * 2. `paseo.json` -> `commander.instructions` or `commanderInstructions` (file path or inline text)
 * 3. Default markdown files in project root (`COMMANDER.md`, `.paseo/COMMANDER.md`, `.paseo/commander.md`, `commander.md`)
 *
 * Returns trimmed instruction string or `null` if no instructions exist.
 */
export async function resolveProjectCommanderInstructions(
  rootPath: string,
): Promise<string | null> {
  if (!rootPath || typeof rootPath !== "string") {
    return null;
  }

  const fromConfig = resolveInstructionsFromPaseoConfig(rootPath);
  if (fromConfig !== null) {
    return fromConfig;
  }

  // Fall back to default instruction files in project root
  for (const filename of DEFAULT_INSTRUCTION_FILENAMES) {
    const content = readProjectFileContent(rootPath, filename);
    if (content !== null) {
      return content;
    }
  }

  return null;
}
