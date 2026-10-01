import { describe, expect, it } from "vitest";
import {
  buildEventDraft,
  githubEventKey,
  linearEventKey,
  matchGithubItem,
  matchLinearItem,
  type GithubPollItem,
  type LinearPollItem,
} from "./poll-matching.js";

const issue: GithubPollItem = {
  kind: "issue",
  number: 12,
  title: "Crash on launch",
  url: "https://github.com/acme/web/issues/12",
  body: "steps",
  labels: ["bug"],
  author: "alice",
  draft: false,
  updatedAt: "2026-09-30T00:00:00.000Z",
};

const linear: LinearPollItem = {
  id: "abc-1",
  identifier: "ENG-12",
  title: "Fix login",
  url: "https://linear.app/team/issue/ENG-12",
  body: null,
  labels: [],
  author: "bob",
  assignees: ["carol"],
  teamKey: "ENG",
  teamName: "Engineering",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

describe("poll-matching", () => {
  it("derives canonical event keys like MonoCode", () => {
    expect(githubEventKey({ kind: "pr", repo: "Acme/Web", number: 12 })).toBe(
      "github:pr:acme/web:12",
    );
    expect(githubEventKey({ kind: "issue", repo: "acme/web", number: 12, label: "Bug!" })).toBe(
      "github:issue:acme/web:12:labelled:bug_",
    );
    expect(linearEventKey({ id: "ABC-1" })).toBe("linear:issue:abc-1");
    expect(linearEventKey({ id: "abc-1", assignee: "Carol" })).toBe(
      "linear:issue:abc-1:assigned:carol",
    );
  });

  it("matches a GitHub issue_opened on repo + label + actor", () => {
    const matched = matchGithubItem(
      { repos: ["acme/web"], events: ["issue_opened"], labels: ["bug"], actors: ["alice"] },
      "acme/web",
      issue,
    );
    expect(matched?.event).toBe("issue_opened");
    expect(matched?.eventKeys).toEqual(["github:issue:acme/web:12"]);
  });

  it("rejects on repo, label, or actor mismatch", () => {
    expect(
      matchGithubItem(
        { repos: ["acme/other"], events: ["issue_opened"], labels: [], actors: [] },
        "acme/web",
        issue,
      ),
    ).toBeNull();
    expect(
      matchGithubItem(
        { repos: [], events: ["issue_opened"], labels: ["p1"], actors: [] },
        "acme/web",
        issue,
      ),
    ).toBeNull();
    expect(
      matchGithubItem(
        { repos: [], events: ["issue_opened"], labels: [], actors: ["mallory"] },
        "acme/web",
        issue,
      ),
    ).toBeNull();
  });

  it("fans labelled out to one key per label", () => {
    const matched = matchGithubItem(
      { repos: [], events: ["labelled"], labels: [], actors: [] },
      "acme/web",
      { ...issue, labels: ["bug", "p1"] },
    );
    expect(matched?.event).toBe("labelled");
    expect(matched?.eventKeys).toEqual([
      "github:issue:acme/web:12:labelled:bug",
      "github:issue:acme/web:12:labelled:p1",
    ]);
  });

  it("matches Linear issue_created on team and assigned on assignee", () => {
    const created = matchLinearItem(
      { repos: ["eng"], events: ["issue_created"], labels: [], actors: [] },
      linear,
    );
    expect(created?.event).toBe("issue_created");
    const assigned = matchLinearItem(
      { repos: [], events: ["assigned"], labels: [], actors: ["carol"] },
      linear,
    );
    expect(assigned?.event).toBe("assigned");
    expect(
      matchLinearItem(
        { repos: ["other"], events: ["issue_created"], labels: [], actors: [] },
        linear,
      ),
    ).toBeNull();
  });

  it("builds a structured event draft block", () => {
    const draft = buildEventDraft({
      provider: "github",
      title: issue.title,
      url: issue.url,
      author: issue.author,
      labels: issue.labels,
      body: issue.body,
      number: issue.number,
    });
    expect(draft).toContain("Source: github");
    expect(draft).toContain("Number: 12");
    expect(draft).toContain("Labels: bug");
  });
});
