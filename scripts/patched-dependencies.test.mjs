import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

for (const platform of ["ios", "android"]) {
  test(`vendored Markdown ships ${platform} props generated from its native specs`, () => {
    const packageDir = path.resolve("packages/react-native-enriched-markdown");
    const output = mkdtempSync(path.join(tmpdir(), `markdown-${platform}-codegen-`));
    try {
      // includesGeneratedCode makes native builds use the shipped headers instead of
      // regenerating them from the TypeScript specs, so a spec edit must regenerate them.
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/react-native/scripts/generate-codegen-artifacts.js"),
          "-p",
          packageDir,
          "-t",
          platform,
          "-o",
          output,
          "-s",
          "library",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const header =
        platform === "ios"
          ? "ReactCodegen/EnrichedMarkdownTextSpec/Props.h"
          : "jni/react/renderer/components/EnrichedMarkdownTextSpec/Props.h";
      assert.equal(
        readFileSync(path.join(packageDir, platform, "generated", header), "utf8"),
        readFileSync(path.join(output, header), "utf8"),
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}
