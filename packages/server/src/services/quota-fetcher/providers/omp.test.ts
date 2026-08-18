import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OmpQuotaProvider } from "./omp.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("OmpQuotaProvider", () => {
  it("expands omp usage --json into Claude, Antigravity, and SuperGrok cards", async () => {
    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({
          generatedAt: Date.now(),
          reports: [
            {
              provider: "anthropic",
              fetchedAt: Date.now(),
              limits: [
                {
                  id: "anthropic:5h",
                  label: "Claude 5 Hour",
                  amount: { usedFraction: 0.12, unit: "percent" },
                  window: { id: "5h", label: "5 Hour", resetsAt: Date.now() + 3_600_000 },
                },
                {
                  id: "anthropic:7d",
                  label: "Claude 7 Day",
                  amount: { usedFraction: 0.38, unit: "percent" },
                  window: { id: "7d", label: "7 Day", resetsAt: Date.now() + 86_400_000 },
                },
              ],
              metadata: { email: "user@example.com", orgName: "Ambient" },
            },
            {
              provider: "google-antigravity",
              fetchedAt: Date.now(),
              limits: [
                {
                  id: "google-antigravity:google:default:daily",
                  label: "Usage (Google)",
                  amount: { usedFraction: 0, unit: "percent" },
                  window: { id: "daily", label: "Daily", resetsAt: Date.now() + 86_400_000 },
                },
              ],
              metadata: { email: "user@example.com", projectId: "proj-1" },
            },
            {
              provider: "xai-oauth",
              fetchedAt: Date.now(),
              limits: [
                {
                  id: "xai-oauth:credits:1w",
                  label: "SuperGrok Weekly Credits",
                  amount: { usedFraction: 0.41, unit: "percent" },
                  window: { id: "1w", label: "Weekly", resetsAt: Date.now() + 604_800_000 },
                },
                {
                  id: "xai-oauth:product:api:1w",
                  label: "API (Weekly)",
                  amount: { usedFraction: 0.38, unit: "percent" },
                  window: { id: "1w", label: "Weekly", resetsAt: Date.now() + 604_800_000 },
                },
                {
                  id: "xai-oauth:included:1mo",
                  label: "SuperGrok Monthly Included",
                  amount: { usedFraction: 1, unit: "unknown" },
                  window: { id: "1mo", label: "Monthly", resetsAt: Date.now() + 172_800_000 },
                },
              ],
              metadata: { billingKind: "unified", email: "user@example.com" },
            },
          ],
          accountsWithoutUsage: [{ provider: "cursor" }],
        }),
        stderr: "",
      }),
      // Prevent fallback SQLite reads during this unit test.
      agentDbPath: join(tmpdir(), "missing-omp-agent.db"),
    });

    const usage = await provider.fetchUsage();
    expect(Array.isArray(usage)).toBe(true);
    if (!Array.isArray(usage)) {
      throw new Error("expected multi-provider usage cards");
    }
    const byId = Object.fromEntries(usage.map((card) => [card.providerId, card]));

    expect(byId["omp-claude"]).toMatchObject({
      providerId: "omp-claude",
      displayName: "OMP · Claude",
      status: "available",
      sourceLabel: "via OMP",
    });
    expect(byId["omp-claude"]?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic:5h", usedPct: 12 }),
        expect.objectContaining({ id: "anthropic:7d", usedPct: 38 }),
      ]),
    );
    expect(byId["omp-antigravity"]).toMatchObject({
      providerId: "omp-antigravity",
      displayName: "OMP · Antigravity",
      status: "available",
    });
    expect(byId["omp"]).toMatchObject({
      providerId: "omp",
      displayName: "OMP · SuperGrok",
      planLabel: "SuperGrok (unified)",
      status: "available",
      windows: [expect.objectContaining({ id: "xai-oauth:credits:1w", usedPct: 41 })],
      details: [],
    });
  });

  it("overrides OMP CLI Antigravity daily bars with Cloud Code weekly/5h summary", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createOauthCredentialDb(dbPath, "google-antigravity", {
      access: "agy-access-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
      projectId: "proj-1",
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly Limit",
                window: "weekly",
                resetTime: "2026-08-03T11:49:40Z",
                remainingFraction: 0.946,
              },
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour Limit",
                window: "5h",
                resetTime: "2026-07-29T15:53:09Z",
                remainingFraction: 0.9869,
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
              {
                bucketId: "3p-weekly",
                displayName: "Weekly Limit",
                window: "weekly",
                resetTime: "2026-08-03T11:49:25Z",
                remainingFraction: 0.9877,
              },
              {
                bucketId: "3p-5h",
                displayName: "Five Hour Limit",
                window: "5h",
                remainingFraction: 1,
              },
            ],
          },
        ],
      }),
    );

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({
          generatedAt: Date.now(),
          reports: [
            {
              provider: "google-antigravity",
              fetchedAt: Date.now(),
              limits: [
                {
                  id: "google-antigravity:google:default:daily",
                  label: "Usage (Google)",
                  amount: { usedFraction: 0, unit: "percent" },
                  window: { id: "daily", label: "Daily", resetsAt: Date.now() + 86_400_000 },
                },
                {
                  id: "google-antigravity:openai:default:daily",
                  label: "Usage (OpenAI)",
                  amount: { usedFraction: 0, unit: "percent" },
                  window: { id: "daily", label: "Daily", resetsAt: Date.now() + 86_400_000 },
                },
                {
                  id: "google-antigravity:anthropic:default:daily",
                  label: "Usage (Anthropic)",
                  amount: { usedFraction: 0, unit: "percent" },
                  window: { id: "daily", label: "Daily", resetsAt: Date.now() + 86_400_000 },
                },
              ],
              metadata: { email: "user@example.com", projectId: "proj-1" },
            },
          ],
        }),
        stderr: "",
      }),
    });

    const usage = await provider.fetchUsage();
    const cards = Array.isArray(usage) ? usage : [usage];
    const antigravity = cards.find((card) => card.providerId === "omp-antigravity");
    expect(antigravity).toMatchObject({
      providerId: "omp-antigravity",
      displayName: "OMP · Antigravity",
      status: "available",
      sourceLabel: "Antigravity via OMP auth",
      details: [{ id: "account_email", label: "Account", value: "user@example.com" }],
    });
    expect(antigravity?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gemini-weekly",
          label: "Gemini · Weekly Limit",
          usedPct: expect.closeTo(5.4, 5),
        }),
        expect.objectContaining({
          id: "gemini-5h",
          label: "Gemini · Five Hour Limit",
          usedPct: expect.closeTo(1.31, 5),
        }),
        expect.objectContaining({
          id: "3p-weekly",
          label: "Claude/GPT · Weekly Limit",
          usedPct: expect.closeTo(1.23, 5),
        }),
        expect.objectContaining({
          id: "3p-5h",
          label: "Claude/GPT · Five Hour Limit",
          usedPct: 0,
        }),
      ]),
    );
    expect(antigravity?.windows).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("falls back to Cursor dashboard API using OMP-stored Cursor auth", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createOauthCredentialDb(dbPath, "cursor", {
      access: "cursor-access-token",
      expires: Date.now() + 60_000,
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        billingCycleStart: "1784842681000",
        billingCycleEnd: "1787521081000",
        planUsage: {
          totalSpend: 423,
          remaining: 1577,
          limit: 2000,
        },
      }),
    );

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({
          generatedAt: Date.now(),
          reports: [],
          accountsWithoutUsage: [{ provider: "cursor" }],
        }),
        stderr: "",
      }),
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      providerId: "omp-cursor",
      displayName: "OMP · Cursor",
      status: "available",
      sourceLabel: "Cursor via OMP auth",
      balances: [
        expect.objectContaining({
          id: "plan_usage",
          unit: "usd",
          used: 4.23,
          remaining: 15.77,
          limit: 20,
        }),
      ],
    });
  });

  it("falls back to SuperGrok billing when omp usage CLI is unavailable", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createOauthCredentialDb(dbPath, "xai-oauth", {
      access: "xai-access-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return jsonResponse({
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-07-28T17:56:58.122Z",
              end: "2026-08-04T17:56:58.122Z",
            },
            creditUsagePercent: 23,
            productUsage: [
              { product: "Api", usagePercent: 23 },
              { product: "GrokBuild", usagePercent: 71 },
            ],
            isUnifiedBillingUser: true,
          },
        });
      }
      return jsonResponse({
        config: {
          monthlyLimit: { val: 15_000 },
          used: { val: 14_770 },
          billingPeriodStart: "2026-07-01T00:00:00Z",
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      });
    });

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
      usageCommandRunner: async () => {
        throw new Error("omp binary missing");
      },
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      providerId: "omp",
      displayName: "OMP · SuperGrok",
      status: "available",
      planLabel: "SuperGrok (unified)",
      sourceLabel: "SuperGrok via OMP auth",
      windows: [expect.objectContaining({ id: "weekly_credits", usedPct: 23 })],
      details: [],
    });
  });

  it("is unavailable when OMP has no usage CLI output and no usable credentials", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createEmptyAuthDb(dbPath);

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({ reports: [], accountsWithoutUsage: [] }),
        stderr: "",
      }),
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      providerId: "omp",
      status: "unavailable",
    });
  });

  it("maps multiple accounts per provider from omp usage --json to distinct cards with groupId and accountEmail", async () => {
    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({
          generatedAt: Date.now(),
          reports: [
            {
              provider: "cursor",
              fetchedAt: Date.now(),
              limits: [
                {
                  id: "cursor:usd:individual-auto",
                  label: "Auto usage",
                  amount: { used: 4.5, limit: 20, unit: "usd" },
                },
              ],
              metadata: { email: "alice@example.com" },
            },
            {
              provider: "cursor",
              fetchedAt: Date.now(),
              limits: [
                {
                  id: "cursor:usd:individual-auto",
                  label: "Auto usage",
                  amount: { used: 12.0, limit: 50, unit: "usd" },
                },
              ],
              metadata: { email: "bob@example.com" },
            },
          ],
        }),
        stderr: "",
      }),
      agentDbPath: join(tmpdir(), "missing-omp-agent.db"),
    });

    const usage = await provider.fetchUsage();
    expect(Array.isArray(usage)).toBe(true);
    if (!Array.isArray(usage)) throw new Error("expected multi-account cards");

    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      providerId: "omp-cursor:alice@example.com",
      groupId: "omp-cursor",
      accountEmail: "alice@example.com",
      displayName: "OMP · Cursor — alice@example.com",
      status: "available",
    });
    expect(usage[1]).toMatchObject({
      providerId: "omp-cursor:bob@example.com",
      groupId: "omp-cursor",
      accountEmail: "bob@example.com",
      displayName: "OMP · Cursor — bob@example.com",
      status: "available",
    });
  });

  it("fetches multiple Grok Build accounts from agent.db with token refresh and emits per-account cards", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");

    // Account 1: valid token
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_live_token_1",
      expires: Date.now() + 600_000,
      email: "alice@example.com",
      accountId: "acc-1",
    });

    // Account 2: expired token with refresh_token
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_expired_token_2",
      refresh: "grok_refresh_token_2",
      expires: Date.now() - 60_000,
      email: "bob@example.com",
      accountId: "acc-2",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("https://auth.x.ai/oauth2/token")) {
        return jsonResponse({
          access_token: "grok_refreshed_token_2",
          expires_in: 3600,
        });
      }
      if (url.includes("https://cli-chat-proxy.grok.com/v1/billing?format=credits")) {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth === "Bearer grok_live_token_1") {
          return jsonResponse({
            config: {
              creditUsagePercent: 30,
              isUnifiedBillingUser: true,
            },
          });
        }
        if (auth === "Bearer grok_refreshed_token_2") {
          return jsonResponse({
            config: {
              creditUsagePercent: 75,
              isUnifiedBillingUser: true,
            },
          });
        }
      }
      return new Response(null, { status: 404 });
    });

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({ reports: [] }),
        stderr: "",
      }),
    });

    const usage = await provider.fetchUsage();
    expect(Array.isArray(usage)).toBe(true);
    if (!Array.isArray(usage)) throw new Error("expected multi-account cards");

    const cards = usage.sort((a, b) => (a.accountEmail ?? "").localeCompare(b.accountEmail ?? ""));
    expect(cards).toHaveLength(2);

    expect(cards[0]).toMatchObject({
      providerId: "omp-grok-build:alice@example.com",
      groupId: "omp-grok-build",
      accountEmail: "alice@example.com",
      displayName: "OMP · Grok Build — alice@example.com",
      status: "available",
      windows: [expect.objectContaining({ id: "weekly_credits", usedPct: 30 })],
    });

    expect(cards[1]).toMatchObject({
      providerId: "omp-grok-build:bob@example.com",
      groupId: "omp-grok-build",
      accountEmail: "bob@example.com",
      displayName: "OMP · Grok Build — bob@example.com",
      status: "available",
      windows: [expect.objectContaining({ id: "weekly_credits", usedPct: 75 })],
    });
  });

  it("isolates account failures so failed accounts show error while valid accounts succeed", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");

    // Account 1: valid
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_good_token",
      expires: Date.now() + 600_000,
      email: "good@example.com",
    });

    // Account 2: expired without refresh token -> fails
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_bad_token",
      expires: Date.now() - 60_000,
      email: "bad@example.com",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("https://cli-chat-proxy.grok.com/v1/billing?format=credits")) {
        return jsonResponse({
          config: {
            creditUsagePercent: 50,
            isUnifiedBillingUser: true,
          },
        });
      }
      return new Response(null, { status: 404 });
    });

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({ reports: [] }),
        stderr: "",
      }),
    });

    const usage = await provider.fetchUsage();
    expect(Array.isArray(usage)).toBe(true);
    if (!Array.isArray(usage)) throw new Error("expected multi-account cards");

    expect(usage).toHaveLength(2);
    const good = usage.find((c) => c.accountEmail === "good@example.com");
    const bad = usage.find((c) => c.accountEmail === "bad@example.com");

    expect(good).toMatchObject({
      providerId: "omp-grok-build:good@example.com",
      status: "available",
      windows: [expect.objectContaining({ usedPct: 50 })],
    });
    expect(bad).toMatchObject({
      providerId: "omp-grok-build:bad@example.com",
      status: "error",
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface StatementSyncLike {
  run(...params: unknown[]): void;
}
interface DatabaseSyncLike {
  prepare(sql: string): StatementSyncLike;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;
}

async function canRunSqlite3(): Promise<boolean> {
  try {
    const sqliteSpecifier: string = "node:sqlite";
    await import(sqliteSpecifier);
    return true;
  } catch {}
  try {
    await execFileAsync("sqlite3", ["-version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function createOauthCredentialDb(
  dbPath: string,
  provider: string,
  data: Record<string, unknown>,
): Promise<void> {
  const sqliteSpecifier: string = "node:sqlite";
  try {
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, data TEXT, updated_at INTEGER, identity_key TEXT, disabled_cause TEXT);",
    ).run();
    db.prepare("INSERT INTO auth_credentials (provider, data, updated_at) VALUES (?, ?, ?);").run(
      provider,
      JSON.stringify(data),
      Date.now(),
    );
    db.close();
    return;
  } catch {}

  const payload = JSON.stringify(data).replaceAll("'", "''");
  const sql = [
    "CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, data TEXT, updated_at INTEGER, identity_key TEXT, disabled_cause TEXT);",
    `INSERT INTO auth_credentials (provider, data, updated_at) VALUES ('${provider}', '${payload}', ${Date.now()});`,
  ].join("");
  await execFileAsync("sqlite3", [dbPath, sql], { timeout: 2_000 });
}

async function createEmptyAuthDb(dbPath: string): Promise<void> {
  const sqliteSpecifier: string = "node:sqlite";
  try {
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, data TEXT, updated_at INTEGER, identity_key TEXT, disabled_cause TEXT);",
    ).run();
    db.close();
    return;
  } catch {}

  await execFileAsync(
    "sqlite3",
    [
      dbPath,
      "CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, data TEXT, updated_at INTEGER, identity_key TEXT, disabled_cause TEXT);",
    ],
    { timeout: 2_000 },
  );
}
