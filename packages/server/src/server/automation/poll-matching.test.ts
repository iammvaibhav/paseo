import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebhookService } from "../webhook/service.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { ScheduleService } from "../schedule/service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PollAutomationStore } from "./poll-store.js";
import { AutomationService } from "./service.js";
import {
  buildEventDraft,
  githubEventKey,
  linearEventKey,
  matchGithubItem,
  matchLinearItem,
  type GithubPollItem,
  type LinearPollItem,
} from "./poll-matching.js";

vi.mock("./github-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-source.js")>();
  return {
    ...actual,
    listGithubIssues: async () => {
      throw new Error("gh issue list failed: auth expired");
    },
    listGithubPrs: async () => {
      throw new Error("gh pr list failed: auth expired");
    },
  };
});

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

describe("poll-store delete serialization", () => {
  it("serializes delete with an in-flight update so the record stays deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-poll-delete-"));
    const store = new PollAutomationStore(join(dir, "polls"), join(dir, "secrets"));
    const created = await store.create({
      name: null,
      provider: "github",
      enabled: true,
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: "/repo" },
      },
      promptTemplate: "triage",
      repos: ["acme/web"],
      events: [],
      labels: [],
      actors: [],
      pollIntervalSec: 300,
      lastCheckedAt: null,
      lastError: null,
      recentRuns: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    let releaseUpdate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const pendingUpdate = store.update(created.id, async (record) => {
      await gate;
      return { ...record, lastError: "ticked" };
    });
    const pendingDelete = store.delete(created.id);
    releaseUpdate();
    await Promise.all([pendingUpdate, pendingDelete]);
    expect(await store.get(created.id)).toBeNull();
  });
});

describe("github poll failures surface as lastError", () => {
  it("records a gh failure on the record instead of treating it as empty", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-poll-gh-fail-"));
    const logger = createTestLogger();
    const agentStorage = new AgentStorage(join(tempDir, "agents"), logger);
    await agentStorage.initialize();
    const agentManager = new AgentManager({ logger });
    const schedules = new ScheduleService({
      paseoHome: tempDir,
      logger,
      agentManager: agentManager as never,
      agentStorage,
      createAgent: (() => {
        throw new Error("no agent creation in poll test");
      }) as never,
      providerSnapshotManager: {
        resolveCreateConfig: async (input: {
          unattended: boolean;
          requestedMode: string;
          featureValues: Record<string, unknown>;
        }) => ({ modeId: input.requestedMode, featureValues: input.featureValues }),
      } as never,
      createDirectoryWorkspace: (async (input: {
        cwd: string;
        firstAgentContext: { prompt: string };
      }) => ({
        workspaceId: "wks_poll_test",
        projectId: "test-project",
        cwd: input.cwd,
        kind: "directory" as const,
        displayName: "test-project",
        title: input.firstAgentContext.prompt,
        branch: null,
        baseBranch: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        archivedAt: null,
      })) as never,
      createPaseoWorktreeWorkspace: (async (input: {
        cwd: string;
        firstAgentContext: { prompt: string };
      }) => ({
        workspace: {
          workspaceId: "wks_poll_test",
          projectId: "test-project",
          cwd: input.cwd,
          kind: "directory" as const,
          displayName: "test-project",
          title: input.firstAgentContext.prompt,
          branch: null,
          baseBranch: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          archivedAt: null,
        },
        worktree: { branchName: "poll-test", worktreePath: input.cwd },
        intent: { kind: "branch-off" as const, baseBranch: "main", branchName: "poll-test" },
        repoRoot: input.cwd,
        created: true,
      })) as never,
      archiveWorkspace: (async () => {}) as never,
    });
    const webhooks = {
      launchTarget: async () => ({ agentId: "ag-1", workspaceId: null }),
    };
    const service = new AutomationService({
      paseoHome: tempDir,
      logger,
      scheduleService: schedules,
      webhookService: webhooks as unknown as WebhookService,
      now: () => new Date("2026-09-30T00:10:00.000Z"),
    });
    const created = await service.create({
      kind: "github",
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      promptTemplate: "triage",
      poll: { repos: ["acme/web"], pollIntervalSec: 60 },
    });
    // Mocked gh failures must surface as the record's lastError (and still
    // advance lastCheckedAt) instead of clearing as a healthy empty poll.
    await service.pollTick(new Date("2026-09-30T01:10:00.000Z"));
    const inspected = await service.inspect(created.id);
    expect(inspected?.poll?.lastError).toMatch(/gh .* list failed/);
    expect(inspected?.poll?.lastCheckedAt).toBe("2026-09-30T01:10:00.000Z");
    await agentStorage.flush();
    await service.stop();
    await rm(tempDir, { recursive: true, force: true });
  });
});
