import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { deriveFallbackAgentTitle, resolveCreateAgentTitles } from "./create-agent-title.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

describe("create-agent-title (spec 06: registration always produces a title)", () => {
  let root: string;
  let logger: ReturnType<typeof createTestLogger>;
  let storage: AgentStorage;
  let codex: NonNullable<ReturnType<typeof createTestAgentClients>["codex"]>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "create-agent-title-"));
    logger = createTestLogger();
    storage = new AgentStorage(path.join(root, "agents"), logger);
    const baseClient = createTestAgentClients().codex;
    if (!baseClient) {
      throw new Error("expected Codex test client");
    }
    codex = baseClient;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("explicit config title wins; first prompt line is clamped to 60 chars", () => {
    const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
      configTitle: "  Ship the auth rewrite  ",
      initialPrompt: "Do the work",
    });
    expect(explicitTitle).toBe("Ship the auth rewrite");
    expect(provisionalTitle).toBe("Ship the auth rewrite");

    const fromPrompt = resolveCreateAgentTitles({
      configTitle: null,
      initialPrompt: "  Fix the payments pipeline before the fleet demo on Friday morning  ",
    });
    // First non-empty line, whitespace-collapsed, clamped to 60 chars.
    expect(fromPrompt.provisionalTitle).toBe(
      "Fix the payments pipeline before the fleet demo on Friday mo",
    );
    expect(fromPrompt.provisionalTitle?.length).toBe(60);
  });

  test("stub format is deterministic and timestamped", () => {
    const fixed = new Date("2026-08-16T10:00:00.000Z");
    expect(deriveFallbackAgentTitle(fixed)).toBe("Agent started 2026-08-16T10:00:00.000Z");
    expect(deriveFallbackAgentTitle(fixed)).toBe(deriveFallbackAgentTitle(fixed));
  });

  test("a no-prompt create (internal/MCP) is registered with the derived stub — title never null", async () => {
    const manager = new AgentManager({
      clients: { codex },
      registry: storage,
      logger,
    });
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, randomUUID(), {
      workspaceId: "wks-no-prompt",
    });
    const record = await storage.get(agent.id);
    // No explicit title, no prompt: the deterministic stub fills the gap.
    expect(record?.title).toMatch(/^Agent started \d{4}-\d{2}-\d{2}T/);
    expect(record?.title).not.toBeNull();
  });

  test("a prompt create derives the title from the first prompt line", async () => {
    const manager = new AgentManager({
      clients: { codex },
      registry: storage,
      logger,
    });
    const agent = await manager.createAgent(
      { provider: "codex", cwd: root, title: undefined },
      randomUUID(),
      {
        workspaceId: "wks-prompt",
        // The caller derives the provisional title from the first prompt
        // line (resolveFirstAgentPromptTitle) and hands it over.
        initialTitle: "Refactor the store layer",
      },
    );
    const record = await storage.get(agent.id);
    expect(record?.title).toBe("Refactor the store layer");
  });

  test("resume of a legacy null-title record backfills the stub (no title:null persists)", async () => {
    const agentId = randomUUID();
    const now = new Date().toISOString();
    // A legacy record (written by an older daemon) whose title is null.
    await storage.upsert({
      id: agentId,
      provider: "codex",
      cwd: root,
      createdAt: now,
      updatedAt: now,
      title: null,
      labels: {},
      lastStatus: "closed",
      config: { provider: "codex", cwd: root },
      persistence: { provider: "codex", sessionId: "session-legacy" },
    });
    const manager = new AgentManager({
      clients: { codex },
      registry: storage,
      logger,
    });
    await manager.resumeAgentFromPersistence(
      { provider: "codex", sessionId: "session-legacy" },
      { cwd: root },
      agentId,
      { workspaceId: "wks-legacy" },
    );
    const record = await storage.get(agentId);
    expect(record?.title).toMatch(/^Agent started \d{4}-\d{2}-\d{2}T/);
    expect(record?.title).not.toBeNull();
  });
});
