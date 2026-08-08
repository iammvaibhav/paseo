import { describe, expect, test } from "vitest";
import {
  buildBackfillPrompt,
  buildWorkspaceRenameProposals,
  DESCRIPTION_MAX_CHARS,
  formatRenameProposalMessage,
  hasFullIdentity,
  isAgentBackfillEligible,
  isDerivedWorkspaceTitle,
  parseBackfillResponse,
  proposalTitleFromSlug,
  resolveIdentityUpdates,
  selectBackfillCandidates,
  WORKSPACE_PROPOSAL_MAX_WORDS,
  type BackfillCandidate,
} from "./naming-backfill.js";

function candidate(overrides: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    agentId: "agent-1",
    name: null,
    title: null,
    shortDescription: null,
    cwd: "/repo/alpha",
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
});

describe("parseBackfillResponse", () => {
  const valid = JSON.stringify({
    agents: [
      { agentId: "agent-1", name: "Ripley", title: "Fix auth", description: "working on auth" },
    ],
  });

  test("parses a bare JSON object", () => {
    const result = parseBackfillResponse(valid);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      agentId: "agent-1",
      name: "Ripley",
      title: "Fix auth",
      description: "working on auth",
    });
  });

  test("strips code fences and omp progress noise", () => {
    const fenced = `Working...\n\`\`\`json\n${valid}\n\`\`\``;
    expect(parseBackfillResponse(fenced)).toHaveLength(1);
  });

  test("ignores prose before the JSON object", () => {
    expect(parseBackfillResponse(`Here you go:\n${valid}`)).toHaveLength(1);
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
    expect(result?.[0]).toEqual({ agentId: "agent-1", name: "Ripley" });
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
});

describe("workspace derived-title heuristic", () => {
  test("null title is a derived default", () => {
    expect(isDerivedWorkspaceTitle({ workspaceId: "w1", name: "feat/x", title: null })).toBe(true);
  });

  test("title equal to the derived name is still a derived default", () => {
    expect(isDerivedWorkspaceTitle({ workspaceId: "w1", name: "feat/x", title: "feat/x" })).toBe(
      true,
    );
  });

  test("a real user title is not a derived default", () => {
    expect(
      isDerivedWorkspaceTitle({ workspaceId: "w1", name: "feat/x", title: "Payments work" }),
    ).toBe(false);
  });

  test("whitespace-only title counts as derived", () => {
    expect(isDerivedWorkspaceTitle({ workspaceId: "w1", name: "feat/x", title: "   " })).toBe(true);
  });
});

describe("proposalTitleFromSlug", () => {
  test("de-slugs branch names with prefixes", () => {
    expect(proposalTitleFromSlug("feat/mc-backfill")).toBe("Mc Backfill");
    expect(proposalTitleFromSlug("fix/auth-timeout")).toBe("Auth Timeout");
    expect(proposalTitleFromSlug("chore_deps")).toBe("Chore Deps");
  });

  test("handles plain slugs without prefixes", () => {
    expect(proposalTitleFromSlug("vaibhav/customizations")).toBe("Vaibhav Customizations");
    expect(proposalTitleFromSlug("v1.2.3")).toBe("V1 2 3");
  });

  test("caps at five words", () => {
    const name = "feat/one-two-three-four-five-six";
    const result = proposalTitleFromSlug(name);
    expect(result?.split(" ")).toHaveLength(WORKSPACE_PROPOSAL_MAX_WORDS);
    expect(result).toBe("One Two Three Four Five");
  });

  test("rejects non-slug names and default branches", () => {
    expect(proposalTitleFromSlug("tmp")).toBeNull();
    expect(proposalTitleFromSlug("paseo")).toBeNull();
    expect(proposalTitleFromSlug("main")).toBeNull();
    expect(proposalTitleFromSlug("master")).toBeNull();
    expect(proposalTitleFromSlug("develop")).toBeNull();
    expect(proposalTitleFromSlug("dev")).toBeNull();
  });

  test("rejects sentence-like derived names containing whitespace", () => {
    expect(proposalTitleFromSlug("Read mc-read-1.txt first word")).toBeNull();
    expect(proposalTitleFromSlug("Add report_milestone tool prompt")).toBeNull();
  });

  test("handles single-word slugs after prefix strip and empty results", () => {
    expect(proposalTitleFromSlug("feat/auth")).toBe("Auth");
    expect(proposalTitleFromSlug("feat/")).toBeNull();
  });
});

describe("buildWorkspaceRenameProposals", () => {
  test("only derived-default titles become proposals", () => {
    const proposals = buildWorkspaceRenameProposals([
      { workspaceId: "w1", name: "feat/payments", title: null },
      { workspaceId: "w2", name: "feat/payments", title: "Payments work" },
      { workspaceId: "w3", name: "tmp", title: null },
      { workspaceId: "w4", name: "main", title: null },
      { workspaceId: "w5", name: "Read mc-read-1.txt first word", title: null },
    ]);
    expect(proposals).toEqual([
      { workspaceId: "w1", oldName: "feat/payments", newName: "Payments" },
    ]);
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
