import { describe, expect, test } from "vitest";
import {
  buildBackfillMarkdownReport,
  buildBackfillPrompt,
  buildBackfillReportAgentChanges,
  deriveTitleFromFirstPrompt,
  DESCRIPTION_MAX_CHARS,
  formatRenameProposalMessage,
  hasFullIdentity,
  isAgentBackfillEligible,
  isSystemWorkspaceName,
  parseBackfillResponse,
  resolveIdentityUpdates,
  resolveWorkspaceRenameProposals,
  selectBackfillCandidates,
  selectWorkspaceProposalCandidates,
  type BackfillCandidate,
  type BackfillWorkspaceResponse,
} from "./naming-backfill.js";

function candidate(overrides: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    agentId: "agent-1",
    name: null,
    title: null,
    shortDescription: null,
    cwd: "/repo/alpha",
    firstPrompt: null,
    lastReportHeadline: null,
    ...overrides,
  };
}

describe("hasFullIdentity / idempotency filter", () => {
  test("all three fields present means complete", () => {
    expect(
      hasFullIdentity({ name: "Ripley", title: "Fix auth", shortDescription: "auth worker" }),
    ).toBe(true);
  });

  test("missing any single field means incomplete", () => {
    expect(hasFullIdentity({ name: "Ripley", title: "Fix auth", shortDescription: null })).toBe(
      false,
    );
    expect(hasFullIdentity({ name: "Ripley", title: null, shortDescription: "auth" })).toBe(false);
    expect(hasFullIdentity({ name: "", title: "Fix auth", shortDescription: "auth" })).toBe(false);
  });

  test("whitespace-only fields count as missing", () => {
    expect(hasFullIdentity({ name: "  ", title: "Fix auth", shortDescription: "auth" })).toBe(
      false,
    );
  });
});

describe("isAgentBackfillEligible / selectBackfillCandidates", () => {
  test("agent missing one field is eligible", () => {
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        name: "Ripley",
        title: "Fix auth",
        shortDescription: null,
      }),
    ).toBe(true);
  });

  test("agent with full identity is skipped", () => {
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        name: "Ripley",
        title: "Fix auth",
        shortDescription: "auth worker",
      }),
    ).toBe(false);
  });

  test("complete agent with an auto-derived title is eligible for title replacement", () => {
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        name: "Ripley",
        title: "Fix the auth flow",
        shortDescription: "auth worker",
        firstPrompt: "Fix the auth flow",
      }),
    ).toBe(true);
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        name: "Ripley",
        title: "fix/auth-slug",
        shortDescription: "auth worker",
        firstPrompt: "fix/auth-slug",
      }),
    ).toBe(true);
  });

  test("complete agent with a user-set title stays skipped even with a prompt", () => {
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        name: "Ripley",
        title: "Payments work",
        shortDescription: "auth worker",
        firstPrompt: "Fix the auth flow",
      }),
    ).toBe(false);
  });

  test("archived, internal, and mission-control-labeled agents are never eligible", () => {
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        name: null,
        title: null,
        shortDescription: null,
        archivedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        title: null,
        shortDescription: null,
        internal: true,
      }),
    ).toBe(false);
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        title: null,
        shortDescription: null,
        labels: { "paseo.mission-control": "commander" },
      }),
    ).toBe(false);
    expect(
      isAgentBackfillEligible({
        agentId: "a1",
        title: null,
        shortDescription: null,
        labels: { "paseo.mission-control": "not-commander" },
      }),
    ).toBe(false);
  });

  test("selectBackfillCandidates keeps only eligible, normalized rows", () => {
    const result = selectBackfillCandidates([
      { agentId: "a1", name: null, title: null, shortDescription: null, cwd: "/x" },
      { agentId: "a2", name: "Ripley", title: "T", shortDescription: "D" },
      { agentId: "a3", name: null, title: "  ", shortDescription: null, cwd: "/y" },
      {
        agentId: "a4",
        name: null,
        title: null,
        shortDescription: null,
        labels: { "paseo.mission-control": "verifier" },
      },
    ]);
    expect(result.map((entry) => entry.agentId)).toEqual(["a1", "a3"]);
    expect(result[1]).toMatchObject({ agentId: "a3", title: null });
  });
});

describe("buildBackfillPrompt", () => {
  test("carries theme, host, and every candidate", () => {
    const prompt = buildBackfillPrompt({
      hostLabel: "work server",
      namingTheme: "nature",
      candidates: [candidate(), candidate({ agentId: "agent-2", cwd: "/repo/beta" })],
    });
    expect(prompt).toContain("work server");
    expect(prompt).toContain('"nature"');
    expect(prompt).toContain("agentId=agent-1");
    expect(prompt).toContain("agentId=agent-2");
    expect(prompt).toContain("/repo/beta");
    expect(prompt).toContain('{"agents":[{"agentId":"..."');
  });

  test("echoes existing titles as source material", () => {
    const prompt = buildBackfillPrompt({
      hostLabel: "h",
      namingTheme: "mixed",
      candidates: [candidate({ title: "Fix auth", cwd: "/x" })],
    });
    expect(prompt).toContain("current title: Fix auth");
  });

  test("carries first prompt excerpt and last report headline per candidate", () => {
    const prompt = buildBackfillPrompt({
      hostLabel: "h",
      namingTheme: "mixed",
      candidates: [
        candidate({
          firstPrompt: "Fix the auth flow so login stops failing",
          lastReportHeadline: "Root cause found",
        }),
      ],
    });
    expect(prompt).toContain('first user prompt: "Fix the auth flow so login stops failing"');
    expect(prompt).toContain('last report: "Root cause found"');
    expect(prompt).toContain("Derive each title from what was ACTUALLY asked");
  });
});

describe("parseBackfillResponse", () => {
  const valid = JSON.stringify({
    agents: [
      { agentId: "agent-1", name: "Ripley", title: "Fix auth", description: "working on auth" },
    ],
  });

  test("parses a bare JSON object", () => {
    const result = parseBackfillResponse(valid);
    expect(result?.agents).toHaveLength(1);
    expect(result?.agents[0]).toMatchObject({
      agentId: "agent-1",
      name: "Ripley",
      title: "Fix auth",
      description: "working on auth",
    });
    expect(result?.workspaces).toEqual([]);
  });

  test("parses workspace proposals in the same payload", () => {
    const result = parseBackfillResponse(
      JSON.stringify({
        agents: [{ agentId: "agent-1", name: "Ripley" }],
        workspaces: [{ workspaceId: "w1", name: "Payments overhaul" }],
      }),
    );
    expect(result?.agents).toHaveLength(1);
    expect(result?.workspaces).toEqual([{ workspaceId: "w1", name: "Payments overhaul" }]);
  });

  test("strips code fences and omp progress noise", () => {
    const fenced = `Working...\n\`\`\`json\n${valid}\n\`\`\``;
    expect(parseBackfillResponse(fenced)?.agents).toHaveLength(1);
  });

  test("ignores prose before the JSON object", () => {
    expect(parseBackfillResponse(`Here you go:\n${valid}`)?.agents).toHaveLength(1);
  });

  test("returns null on malformed or missing JSON", () => {
    expect(parseBackfillResponse("no json here")).toBeNull();
    expect(parseBackfillResponse('{"agents": [')).toBeNull();
    expect(parseBackfillResponse('{"agents": [{"agentId": 42}]}')).toBeNull();
  });

  test("tolerates partial entries (optional fields)", () => {
    const result = parseBackfillResponse(
      JSON.stringify({ agents: [{ agentId: "agent-1", name: "Ripley" }] }),
    );
    expect(result?.agents[0]).toEqual({ agentId: "agent-1", name: "Ripley" });
  });
});

describe("resolveIdentityUpdates (apply-time idempotency)", () => {
  test("fills only missing fields from the response", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ name: "Ripley", title: null, shortDescription: null })],
      responses: [
        { agentId: "agent-1", name: "Ripley", title: "Fix auth", description: "auth worker" },
      ],
    });
    expect(updates).toEqual([
      { agentId: "agent-1", title: "Fix auth", shortDescription: "auth worker" },
    ]);
  });

  test("no update when the agent is already complete", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ name: "R", title: "T", shortDescription: "D" })],
      responses: [{ agentId: "agent-1", name: "X", title: "Y", description: "Z" }],
    });
    expect(updates).toEqual([]);
  });

  test("drops responses for unknown agentIds", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate()],
      responses: [{ agentId: "ghost", name: "X" }],
    });
    expect(updates).toEqual([]);
  });

  test("drops over-long descriptions and empty fields", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate()],
      responses: [
        {
          agentId: "agent-1",
          name: "  ",
          title: "T",
          description: "x".repeat(DESCRIPTION_MAX_CHARS + 1),
        },
      ],
    });
    expect(updates).toEqual([{ agentId: "agent-1", title: "T" }]);
  });

  test("accepts a description at the 400-char cap (Commander's context rule)", () => {
    const description = "x".repeat(DESCRIPTION_MAX_CHARS);
    const updates = resolveIdentityUpdates({
      candidates: [candidate()],
      responses: [{ agentId: "agent-1", name: "Nova", title: "T", description }],
    });
    expect(updates).toEqual([
      { agentId: "agent-1", name: "Nova", title: "T", shortDescription: description },
    ]);
  });
});

describe("deriveTitleFromFirstPrompt (same derivation as create-agent-title)", () => {
  test("uses the first content line, whitespace-collapsed", () => {
    expect(deriveTitleFromFirstPrompt("  Fix the auth flow  ")).toBe("Fix the auth flow");
    expect(deriveTitleFromFirstPrompt("Fix auth\nAdd tests for it")).toBe("Fix auth");
  });

  test("clamps to 60 chars", () => {
    const long = "w".repeat(100);
    expect(deriveTitleFromFirstPrompt(long)).toHaveLength(60);
  });

  test("null on empty prompts", () => {
    expect(deriveTitleFromFirstPrompt(null)).toBeNull();
    expect(deriveTitleFromFirstPrompt("   ")).toBeNull();
    expect(deriveTitleFromFirstPrompt("")).toBeNull();
  });
});

describe("resolveIdentityUpdates (title replacement heuristic)", () => {
  test("replaces a title equal to the first-prompt derivation (auto-generated)", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ title: "Fix the auth flow", firstPrompt: "Fix the auth flow" })],
      responses: [{ agentId: "agent-1", title: "Overhaul login auth" }],
    });
    expect(updates).toEqual([{ agentId: "agent-1", title: "Overhaul login auth" }]);
  });

  test("replaces a derived title even when clamped from a long first prompt", () => {
    const firstPrompt = "Fix the auth flow and add tests for the new token refresh path today";
    const derived = deriveTitleFromFirstPrompt(firstPrompt);
    expect(derived).not.toBeNull();
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ title: derived, firstPrompt })],
      responses: [{ agentId: "agent-1", title: "Auth overhaul" }],
    });
    expect(updates).toEqual([{ agentId: "agent-1", title: "Auth overhaul" }]);
  });

  test("keeps a user-set title that differs from the derivation", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ title: "Payments work", firstPrompt: "Fix the auth flow" })],
      responses: [{ agentId: "agent-1", title: "Overhaul login auth" }],
    });
    expect(updates).toEqual([]);
  });

  test("keeps a user-set title when no first prompt is available", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ title: "Payments work" })],
      responses: [{ agentId: "agent-1", title: "Overhaul login auth" }],
    });
    expect(updates).toEqual([]);
  });

  test("still fills a missing title (fill-if-missing unchanged)", () => {
    const updates = resolveIdentityUpdates({
      candidates: [candidate({ title: null, firstPrompt: "Fix the auth flow" })],
      responses: [{ agentId: "agent-1", title: "Auth overhaul" }],
    });
    expect(updates).toEqual([{ agentId: "agent-1", title: "Auth overhaul" }]);
  });

  test("names and descriptions stay fill-if-missing even when the title is replaced", () => {
    const updates = resolveIdentityUpdates({
      candidates: [
        candidate({
          title: "Fix the auth flow",
          firstPrompt: "Fix the auth flow",
          shortDescription: "existing description",
        }),
      ],
      responses: [
        {
          agentId: "agent-1",
          name: "Nova",
          title: "Overhaul login auth",
          description: "replacement description",
        },
      ],
    });
    // name still missing → filled; description present → untouched.
    expect(updates).toEqual([{ agentId: "agent-1", name: "Nova", title: "Overhaul login auth" }]);
  });
});

describe("isSystemWorkspaceName", () => {
  test("the commander-home marker is a system workspace", () => {
    expect(isSystemWorkspaceName("<paseo-system>")).toBe(true);
    expect(isSystemWorkspaceName("  <paseo-system>  ")).toBe(true);
    expect(isSystemWorkspaceName("feat/payments")).toBe(false);
    expect(isSystemWorkspaceName(null)).toBe(false);
    expect(isSystemWorkspaceName(undefined)).toBe(false);
  });
});

describe("selectWorkspaceProposalCandidates", () => {
  test("sends every non-system, non-home workspace to the one-shot (LLM decides)", () => {
    const candidates = selectWorkspaceProposalCandidates([
      { workspaceId: "w1", name: "feat/payments", title: null },
      { workspaceId: "w2", name: "Payments work", title: "Payments work" },
      { workspaceId: "w3", name: "stackmod", title: "stackmod" },
      { workspaceId: "w4", name: "breezeapi", title: null },
      { workspaceId: "w5", name: "thankful-penguin", title: null },
      {
        workspaceId: "w6",
        name: "<paseo-system>",
        title: null,
        cwd: "/Users/vaibhav",
        agents: [{ title: "Fix auth", shortDescription: null }],
      },
    ]);
    // Auto-generated names, user-titled workspaces, and slug names ALL go in —
    // only the system workspace is excluded.
    expect(candidates.map((c) => c.workspaceId)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  test("carries the workspace's agents as context", () => {
    const candidates = selectWorkspaceProposalCandidates([
      {
        workspaceId: "w1",
        name: "feat/payments",
        title: null,
        agents: [
          { title: "Fix the payments flow", shortDescription: "payments worker" },
          { title: null, shortDescription: "auth" },
        ],
      },
    ]);
    expect(candidates[0]?.agents).toEqual([
      { title: "Fix the payments flow", shortDescription: "payments worker" },
      { title: null, shortDescription: "auth" },
    ]);
  });

  test("home-dir workspaces are excluded when homeDir is provided", () => {
    const candidates = selectWorkspaceProposalCandidates(
      [
        { workspaceId: "w1", name: "feat/x", title: null, cwd: "/Users/vaibhav" },
        { workspaceId: "w2", name: "feat/y", title: null, cwd: "/Users/vaibhav/project" },
      ],
      { homeDir: "/Users/vaibhav" },
    );
    expect(candidates.map((c) => c.workspaceId)).toEqual(["w2"]);
  });
});

describe("resolveWorkspaceRenameProposals (LLM workspace names)", () => {
  const candidates = selectWorkspaceProposalCandidates([
    { workspaceId: "w1", name: "feat/payments", title: null },
    { workspaceId: "w2", name: "fix/auth", title: null },
  ]);

  function response(overrides: Partial<BackfillWorkspaceResponse>): BackfillWorkspaceResponse {
    return { workspaceId: "w1", name: "Payments overhaul", ...overrides };
  }

  test("uses the LLM-proposed names (no mechanical title-casing)", () => {
    const proposals = resolveWorkspaceRenameProposals(candidates, [
      response({ name: "Payments API overhaul" }),
      response({ workspaceId: "w2", name: "Auth flow fix" }),
    ]);
    expect(proposals).toEqual([
      { workspaceId: "w1", oldName: "feat/payments", newName: "Payments API overhaul" },
      { workspaceId: "w2", oldName: "fix/auth", newName: "Auth flow fix" },
    ]);
  });

  test("drops unknown workspaceIds, empty names, and over-long names", () => {
    const proposals = resolveWorkspaceRenameProposals(candidates, [
      response({ workspaceId: "ghost", name: "Whatever" }),
      response({ name: "   " }),
      response({ name: "one two three four five six" }),
    ]);
    expect(proposals).toEqual([]);
  });

  test("drops names at or under the word cap but keeps exactly 5 words", () => {
    const proposals = resolveWorkspaceRenameProposals(candidates, [
      response({ name: "one two three four five" }),
    ]);
    expect(proposals).toEqual([
      { workspaceId: "w1", oldName: "feat/payments", newName: "one two three four five" },
    ]);
  });

  test("drops a proposal that echoes the current name", () => {
    expect(
      resolveWorkspaceRenameProposals(candidates, [response({ name: "feat/payments" })]),
    ).toEqual([]);
  });
});

describe("formatRenameProposalMessage", () => {
  test("lists one old -> new line per proposal and notes manual apply", () => {
    const message = formatRenameProposalMessage(
      [
        { workspaceId: "w1", oldName: "feat/payments", newName: "Payments" },
        { workspaceId: "w2", oldName: "fix/auth", newName: "Auth Fix" },
      ],
      "work server",
    );
    expect(message).toContain("Work server");
    expect(message).toContain("feat/payments -> Payments");
    expect(message).toContain("fix/auth -> Auth Fix");
    expect(message).toContain("--apply <approved.json>");
  });
});

describe("buildBackfillPrompt workspace section", () => {
  test("lists workspaces with agent context and instructs the LLM on auto names", () => {
    const prompt = buildBackfillPrompt({
      hostLabel: "h",
      namingTheme: "mixed",
      candidates: [],
      workspaceCandidates: [
        {
          workspaceId: "w1",
          name: "feat/payments",
          agents: [
            { title: "Fix the payments flow", shortDescription: "payments worker" },
            { title: null, shortDescription: null },
          ],
        },
        {
          workspaceId: "w2",
          name: "Explain advisory feed freshness for npm install checks",
          agents: [],
        },
      ],
    });
    expect(prompt).toContain('workspaceId=w1 | current name: "feat/payments"');
    expect(prompt).toContain('agents working here: "Fix the payments flow" — payments worker');
    expect(prompt).toContain("branch/dir slugs");
    expect(prompt).toContain('"thankful-penguin"');
    expect(prompt).toContain("max 5 words");
    expect(prompt).toContain("intentional human name");
    expect(prompt).toContain('"workspaces":[{"workspaceId":"...","name":"..."}]');
  });
});

describe("buildBackfillReportAgentChanges", () => {
  test("diffs candidates against updates into per-field rows", () => {
    const rows = buildBackfillReportAgentChanges(
      [candidate({ name: null, title: "Fix the auth flow", shortDescription: "auth" })],
      [
        {
          agentId: "agent-1",
          name: "Nova",
          title: "Overhaul login auth",
          shortDescription: "working on login",
        },
      ],
    );
    expect(rows).toEqual([
      { agentId: "agent-1", field: "name", oldValue: null, newValue: "Nova" },
      {
        agentId: "agent-1",
        field: "title",
        oldValue: "Fix the auth flow",
        newValue: "Overhaul login auth",
      },
      {
        agentId: "agent-1",
        field: "description",
        oldValue: "auth",
        newValue: "working on login",
      },
    ]);
  });

  test("ignores updates for unknown candidates", () => {
    expect(
      buildBackfillReportAgentChanges([candidate()], [{ agentId: "ghost", title: "X" }]),
    ).toEqual([]);
  });
});

describe("buildBackfillMarkdownReport", () => {
  const report = buildBackfillMarkdownReport({
    hostLabel: "work server",
    namingTheme: "nature",
    generatedAt: "2026-08-08T00:00:00.000Z",
    agentChanges: [
      { agentId: "agent-1", field: "name", oldValue: null, newValue: "Nova" },
      {
        agentId: "agent-1",
        field: "title",
        oldValue: "fix/auth",
        newValue: "Overhaul login auth",
      },
    ],
    workspaceProposals: [{ workspaceId: "w1", oldName: "feat/payments", newName: "Payments" }],
  });

  test("has the report header, how-to-approve section, and both tables", () => {
    expect(report).toContain("# Mission Control naming backfill report");
    expect(report).toContain("Host: `work server`");
    expect(report).toContain("Naming theme: `nature`");
    expect(report).toContain("Generated: 2026-08-08T00:00:00.000Z");
    expect(report).toContain("## How to approve");
    expect(report).toContain("**Nothing has been applied yet.**");
    expect(report).toContain("delete any row you reject");
    expect(report).toContain("--apply <approved.json>");
  });

  test("agent table carries old → new rows", () => {
    expect(report).toContain("| Agent | Field | Old | New |");
    expect(report).toContain("| agent-1 | name | — | Nova |");
    expect(report).toContain("| agent-1 | title | fix/auth | Overhaul login auth |");
  });

  test("workspace table carries old → new rows", () => {
    expect(report).toContain("| Workspace | Old name | New name |");
    expect(report).toContain("| w1 | feat/payments | Payments |");
  });

  test("empty sections render as explicit no-change notes", () => {
    const empty = buildBackfillMarkdownReport({
      hostLabel: "h",
      namingTheme: "mixed",
      generatedAt: "2026-08-08T00:00:00.000Z",
      agentChanges: [],
      workspaceProposals: [],
    });
    expect(empty).toContain("_No agent identity changes._");
    expect(empty).toContain("_No workspace renames._");
  });
});
