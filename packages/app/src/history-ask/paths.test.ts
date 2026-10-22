import { describe, expect, it } from "vitest";
import {
  buildHistorySearchRoots,
  encodeClaudeProjectDir,
  encodeGrokSessionDir,
  sanitizePaseoAgentDir,
} from "./paths";

describe("sanitizePaseoAgentDir", () => {
  it("strips unix root and replaces separators", () => {
    expect(sanitizePaseoAgentDir("/Users/vaibhav/paseo")).toBe("Users-vaibhav-paseo");
  });

  it("handles trailing separators", () => {
    expect(sanitizePaseoAgentDir("/tmp/project/")).toBe("tmp-project");
  });

  it("handles windows-style drive paths", () => {
    expect(sanitizePaseoAgentDir("C:\\Users\\me\\repo")).toBe("C-Users-me-repo");
  });

  it("handles root alone", () => {
    expect(sanitizePaseoAgentDir("/")).toBe("root");
  });
});

describe("encodeClaudeProjectDir", () => {
  it("replaces non-alphanumeric with dashes", () => {
    expect(encodeClaudeProjectDir("/Users/vaibhav/my project")).toBe("-Users-vaibhav-my-project");
  });

  it("caps long paths with a hash suffix", () => {
    const long = `/${"a".repeat(250)}`;
    const encoded = encodeClaudeProjectDir(long);
    expect(encoded.length).toBeLessThanOrEqual(200 + 1 + 12);
    expect(encoded.startsWith("-")).toBe(true);
    expect(encoded.includes("-")).toBe(true);
    // Cap + hash
    expect(encoded.length).toBeGreaterThan(200);
  });
});

describe("encodeGrokSessionDir", () => {
  it("uses encodeURIComponent", () => {
    expect(encodeGrokSessionDir("/Users/vaibhav/paseo")).toBe(
      encodeURIComponent("/Users/vaibhav/paseo"),
    );
  });
});

describe("buildHistorySearchRoots", () => {
  it("builds path hints for each cwd and dedupes", () => {
    const roots = buildHistorySearchRoots([
      "/Users/vaibhav/paseo",
      "/Users/vaibhav/paseo",
      "  ",
      "/tmp/other",
    ]);
    expect(roots.cwds).toEqual(["/Users/vaibhav/paseo", "/tmp/other"]);
    expect(roots.paseoAgentDirs).toEqual([
      "~/.paseo/agents/Users-vaibhav-paseo",
      "~/.paseo/agents/tmp-other",
    ]);
    expect(roots.claudeProjectDirs[0]).toContain("~/.claude/projects/");
    expect(roots.grokSessionDirs[0]).toContain("~/.grok/sessions/");
  });
});
