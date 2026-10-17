import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBundledSkillsDir, resolveSkillTargets } from "./paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("orchestration skill paths", () => {
  it("finds the repository catalog from the source module", () => {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../..",
    );

    expect(resolveBundledSkillsDir()).toBe(path.join(repositoryRoot, "skills"));
  });

  it("finds the catalog beside the actual emitted server layout", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-built-skills-"));
    roots.push(packageRoot);
    const catalog = path.join(packageRoot, "dist", "server", "skills");
    await mkdir(catalog, { recursive: true });
    const emittedModule = path.join(
      packageRoot,
      "dist",
      "server",
      "server",
      "orchestration-skills",
      "internal",
      "paths.js",
    );

    expect(resolveBundledSkillsDir(pathToFileURL(emittedModule))).toBe(catalog);
  });

  it("keeps the original fixed managed directories under the daemon user's home", () => {
    const home = os.homedir();

    expect(resolveSkillTargets()).toMatchObject({
      agentsDir: path.join(home, ".agents", "skills"),
      claudeDir: path.join(home, ".claude", "skills"),
      codexDir: path.join(home, ".codex", "skills"),
    });
  });

  it("honors PASEO_SKILLS_HOME when set", () => {
    const customHome = "/tmp/custom-skills-home";
    const previous = process.env.PASEO_SKILLS_HOME;
    try {
      process.env.PASEO_SKILLS_HOME = customHome;
      expect(resolveSkillTargets()).toMatchObject({
        agentsDir: path.join(customHome, ".agents", "skills"),
        claudeDir: path.join(customHome, ".claude", "skills"),
        codexDir: path.join(customHome, ".codex", "skills"),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PASEO_SKILLS_HOME;
      } else {
        process.env.PASEO_SKILLS_HOME = previous;
      }
    }
  });
});
