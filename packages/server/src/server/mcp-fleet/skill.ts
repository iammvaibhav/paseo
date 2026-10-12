import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FLEET_SKILL_RELATIVE_PATH = join("resources", "paseo-fleet-skill.md");

function resolvePackageRootPath(moduleDir: string, relative: string): string {
  let currentDir = moduleDir;
  while (true) {
    if (existsSync(join(currentDir, "package.json"))) {
      return join(currentDir, relative);
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return join(currentDir, relative);
    }
    currentDir = parentDir;
  }
}

export function loadFleetSkillText(
  explicitPath?: string | null,
  moduleUrl: string = import.meta.url,
): string {
  if (explicitPath) {
    return readFileSync(explicitPath, "utf8");
  }
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDir, "..", "..", FLEET_SKILL_RELATIVE_PATH),
    join(moduleDir, "..", "..", "..", FLEET_SKILL_RELATIVE_PATH),
    resolvePackageRootPath(moduleDir, FLEET_SKILL_RELATIVE_PATH),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }
  throw new Error(`Unable to locate resources/paseo-fleet-skill.md from ${moduleDir}`);
}
