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
      displayName: "Claude",
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
      displayName: "Antigravity",
      status: "available",
    });
    expect(byId["omp"]).toMatchObject({
      providerId: "omp",
      displayName: "SuperGrok",
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
      displayName: "Antigravity",
      status: "available",
      sourceLabel: "via OMP",
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

  it("refreshes an expired google-antigravity token in memory and uses the direct quota summary", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createOauthCredentialDb(dbPath, "google-antigravity", {
      access: "agy-expired-access-token",
      refresh: "agy-refresh-token",
      expires: Date.now() - 60_000,
      email: "user@example.com",
      projectId: "proj-1",
    });

    const requestedUrls: string[] = [];
    const refreshBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        refreshBodies.push(String(init?.body));
        return jsonResponse({ access_token: "agy-fresh-access-token", expires_in: 3599 });
      }
      return jsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.946 },
              { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9869 },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.9877 },
              { bucketId: "3p-5h", window: "5h", remainingFraction: 1 },
            ],
          },
        ],
      });
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
    const cards = Array.isArray(usage) ? usage : [usage];
    const antigravity = cards.find((card) => card.providerId === "omp-antigravity");
    expect(antigravity).toMatchObject({
      providerId: "omp-antigravity",
      displayName: "Antigravity",
      status: "available",
    });
    expect(antigravity?.windows).toHaveLength(4);

    // The Google token endpoint was called exactly once, with the discovered
    // client pair and the OMP-stored refresh token.
    expect(
      requestedUrls.filter((url) => url === "https://oauth2.googleapis.com/token"),
    ).toHaveLength(1);
    expect(refreshBodies).toHaveLength(1);
    expect(refreshBodies[0]).toContain(
      "client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    );
    expect(refreshBodies[0]).toContain("grant_type=refresh_token");
    expect(refreshBodies[0]).toContain("refresh_token=agy-refresh-token");
    // Rotating-token providers must never be touched.
    expect(
      requestedUrls.some((url) => url.includes("auth.x.ai") || url.includes("auth.openai.com")),
    ).toBe(false);
    expect(requestedUrls.some((url) => url.includes("platform.claude.com"))).toBe(false);
  });

  it("falls back to the CLI card when the google-antigravity refresh fails", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createOauthCredentialDb(dbPath, "google-antigravity", {
      access: "agy-expired-access-token",
      refresh: "agy-refresh-token",
      expires: Date.now() - 60_000,
      email: "user@example.com",
      projectId: "proj-1",
    });

    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(null, { status: 404 });
    });

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
                  amount: { usedFraction: 0.1, unit: "percent" },
                  window: { id: "daily", label: "Daily", resetsAt: Date.now() + 86_400_000 },
                },
                {
                  id: "google-antigravity:openai:default:daily",
                  label: "Usage (OpenAI)",
                  amount: { usedFraction: 0.2, unit: "percent" },
                  window: { id: "daily", label: "Daily", resetsAt: Date.now() + 86_400_000 },
                },
                {
                  id: "google-antigravity:anthropic:default:daily",
                  label: "Usage (Anthropic)",
                  amount: { usedFraction: 0.3, unit: "percent" },
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
      displayName: "Antigravity",
      status: "available",
    });
    // CLI fallback shape: three short-window daily bars, not the 4-window summary.
    expect(antigravity?.windows).toHaveLength(3);
    expect(antigravity?.windows?.every((window) => window.id.endsWith(":daily"))).toBe(true);
    // One refresh attempt, then no direct summary fetch (token stayed unusable).
    expect(
      requestedUrls.filter((url) => url === "https://oauth2.googleapis.com/token"),
    ).toHaveLength(1);
    expect(requestedUrls.some((url) => url.includes("retrieveUserQuotaSummary"))).toBe(false);
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
      displayName: "Cursor",
      status: "available",
      sourceLabel: "via OMP",
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
      displayName: "SuperGrok",
      status: "available",
      planLabel: "SuperGrok (unified)",
      sourceLabel: "via OMP",
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
      displayName: "Cursor",
      status: "available",
    });
    expect(usage[1]).toMatchObject({
      providerId: "omp-cursor:bob@example.com",
      groupId: "omp-cursor",
      accountEmail: "bob@example.com",
      displayName: "Cursor",
      status: "available",
    });
  });

  it("fetches multiple Grok Build accounts from agent.db and emits per-account cards", async () => {
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

    // Account 2: expired token (refresh token present, but Paseo must never use it)
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_expired_token_2",
      refresh: "grok_refresh_token_2",
      expires: Date.now() - 60_000,
      email: "bob@example.com",
      accountId: "acc-2",
    });

    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
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
      displayName: "Grok Build",
      status: "available",
      windows: [expect.objectContaining({ id: "weekly_credits", usedPct: 30 })],
    });

    expect(cards[1]).toMatchObject({
      providerId: "omp-grok-build:bob@example.com",
      groupId: "omp-grok-build",
      accountEmail: "bob@example.com",
      displayName: "Grok Build",
      status: "unavailable",
      windows: [],
      error: "Token expired — will recover when OMP refreshes it",
    });

    // Paseo must never call OAuth token endpoints with OMP-stored refresh tokens.
    expect(requestedUrls.some((url) => url.includes("/oauth2/token"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("auth.openai.com"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("platform.claude.com"))).toBe(false);
  });

  it("asks OMP to refresh an expired Grok Build token before collecting usage", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "expired_token",
      refresh: "refresh_token",
      expires: Date.now() - 60_000,
      email: "build@example.com",
    });

    const commands: string[][] = [];
    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      agentDbPath: dbPath,
      usageCommandRunner: async ({ args }) => {
        commands.push(args);
        if (args[0] === "token") {
          await updateOauthCredentialDb(dbPath, "grok-build", {
            access: "fresh_token",
            refresh: "rotated_refresh_token",
            expires: Date.now() + 600_000,
            email: "build@example.com",
          });
          return { stdout: "fresh_token", stderr: "" };
        }
        return { stdout: JSON.stringify({ reports: [] }), stderr: "" };
      },
      fetch: vi.fn(async (_input, init) => {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer fresh_token");
        return jsonResponse({
          config: {
            creditUsagePercent: 20,
            isUnifiedBillingUser: true,
          },
        });
      }) as unknown as typeof fetch,
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      providerId: "omp-grok-build",
      status: "available",
      windows: [expect.objectContaining({ id: "weekly_credits", usedPct: 20 })],
    });
    expect(commands).toEqual([
      ["token", "grok-build", "--account", "1"],
      ["usage", "--json"],
    ]);
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

    // Account 2: expired without refresh token -> unavailable
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
      status: "unavailable",
      windows: [],
      error: "Token expired — will recover when OMP refreshes it",
    });
  });

  it("never calls OAuth token endpoints when OMP-stored tokens are expired", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");

    // Every provider with a refresh-capable credential: expired, refresh token present.
    await createOauthCredentialDb(dbPath, "xai-oauth", {
      access: "xai_expired",
      refresh: "xai_refresh",
      expires: Date.now() - 60_000,
      email: "super@example.com",
    });
    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_expired",
      refresh: "grok_refresh",
      expires: Date.now() - 60_000,
      email: "build@example.com",
    });
    await createOauthCredentialDb(dbPath, "openai-codex", {
      access: "codex_expired",
      refresh: "codex_refresh",
      expires: Date.now() - 60_000,
      email: "codex@example.com",
    });
    await createOauthCredentialDb(dbPath, "anthropic", {
      access: "claude_expired",
      refresh: "claude_refresh",
      expires: Date.now() - 60_000,
      email: "claude@example.com",
    });

    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(null, { status: 404 });
    });

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({ reports: [], accountsWithoutUsage: [] }),
        stderr: "",
      }),
    });

    const usage = await provider.fetchUsage();
    expect(Array.isArray(usage)).toBe(true);
    if (!Array.isArray(usage)) throw new Error("expected cards");

    const byId = Object.fromEntries(usage.map((card) => [card.providerId, card]));
    expect(byId["omp"]).toMatchObject({
      status: "unavailable",
      error: "Token expired — will recover when OMP refreshes it",
    });
    expect(byId["omp-grok-build"]).toMatchObject({
      status: "unavailable",
      error: "Token expired — will recover when OMP refreshes it",
    });

    // No OAuth token endpoint may be called with OMP-stored refresh tokens.
    expect(
      requestedUrls.some((url) => url.includes("auth.x.ai") || url.includes("auth.openai.com")),
    ).toBe(false);
    expect(requestedUrls.some((url) => url.includes("platform.claude.com"))).toBe(false);
  });

  it("asks for re-authentication when the CLI also reports an auth failure", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");

    await createOauthCredentialDb(dbPath, "grok-build", {
      access: "grok_expired",
      refresh: "grok_refresh",
      expires: Date.now() - 60_000,
      email: "build@example.com",
    });

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      agentDbPath: dbPath,
      usageCommandRunner: async () => ({
        stdout: JSON.stringify({
          reports: [],
          accountsWithoutUsage: [
            { provider: "grok-build", error: "refresh failed: invalid_grant" },
          ],
        }),
        stderr: "",
      }),
    });

    const usage = await provider.fetchUsage();
    const cards = Array.isArray(usage) ? usage : [usage];

    expect(cards[0]).toMatchObject({
      providerId: "omp-grok-build",
      status: "unavailable",
      error: "Token expired — re-authenticate in OMP",
    });
  });

  it("emits unavailable cards for disabled accounts without using their tokens", async () => {
    if (!(await canRunSqlite3())) return;

    const dir = mkdtempSync(join(tmpdir(), "omp-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "agent.db");

    // Disabled grok-build: valid token + refresh token, but OMP disabled the row
    // after its own refresh hit a revoked token. The token must never be used.
    await createOauthCredentialDb(
      dbPath,
      "grok-build",
      {
        access: "grok_disabled_token",
        refresh: "grok_disabled_refresh",
        expires: Date.now() + 600_000,
        email: "build@example.com",
      },
      "refresh token revoked",
    );
    // Disabled anthropic: no direct-API fetcher exists, but the card must still surface.
    await createOauthCredentialDb(
      dbPath,
      "anthropic",
      {
        access: "claude_disabled_token",
        refresh: "claude_disabled_refresh",
        expires: Date.now() + 600_000,
        email: "claude@example.com",
      },
      "user revoked",
    );
    // Disabled cursor WITH a CLI report: the CLI card wins (stay as-is).
    await createOauthCredentialDb(
      dbPath,
      "cursor",
      {
        access: "cursor_disabled_token",
        expires: Date.now() + 600_000,
        email: "cursor@example.com",
      },
      "test disabled",
    );

    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(null, { status: 404 });
    });

    const provider = new OmpQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchMock as unknown as typeof fetch,
      agentDbPath: dbPath,
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
              metadata: { email: "cursor@example.com" },
            },
          ],
          accountsWithoutUsage: [],
        }),
        stderr: "",
      }),
    });

    const usage = await provider.fetchUsage();
    const cards = Array.isArray(usage) ? usage : [usage];
    const byId = Object.fromEntries(cards.map((card) => [card.providerId, card]));

    expect(byId["omp-grok-build"]).toMatchObject({
      providerId: "omp-grok-build",
      status: "unavailable",
      error: "Account disabled in OMP — re-authenticate (refresh token revoked)",
    });
    expect(byId["omp-claude"]).toMatchObject({
      providerId: "omp-claude",
      status: "unavailable",
      error: "Account disabled in OMP — re-authenticate (user revoked)",
    });
    // CLI-covered disabled account keeps its CLI card.
    expect(byId["omp-cursor"]).toMatchObject({
      providerId: "omp-cursor",
      status: "available",
      windows: [
        expect.objectContaining({
          id: "cursor:usd:individual-auto",
          usedPct: expect.closeTo(22.5, 5),
        }),
      ],
    });

    // No billing or OAuth token endpoint may be called for disabled accounts.
    expect(requestedUrls).toEqual([]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function updateOauthCredentialDb(
  dbPath: string,
  provider: string,
  data: Record<string, unknown>,
): Promise<void> {
  const sqliteSpecifier: string = "node:sqlite";
  try {
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE auth_credentials SET data = ?, updated_at = ? WHERE provider = ?;").run(
      JSON.stringify(data),
      Date.now(),
      provider,
    );
    db.close();
    return;
  } catch {}

  const payload = JSON.stringify(data).replaceAll("'", "''");
  const sql = `UPDATE auth_credentials SET data = '${payload}', updated_at = ${Date.now()} WHERE provider = '${provider}';`;
  await execFileAsync("sqlite3", [dbPath, sql], { timeout: 2_000 });
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
  disabledCause?: string,
): Promise<void> {
  const sqliteSpecifier: string = "node:sqlite";
  try {
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, data TEXT, updated_at INTEGER, identity_key TEXT, disabled_cause TEXT);",
    ).run();
    db.prepare(
      "INSERT INTO auth_credentials (provider, data, updated_at, disabled_cause) VALUES (?, ?, ?, ?);",
    ).run(provider, JSON.stringify(data), Date.now(), disabledCause ?? null);
    db.close();
    return;
  } catch {}

  const payload = JSON.stringify(data).replaceAll("'", "''");
  const cause = disabledCause === undefined ? "NULL" : `'${disabledCause.replaceAll("'", "''")}'`;
  const sql = [
    "CREATE TABLE IF NOT EXISTS auth_credentials (provider TEXT, data TEXT, updated_at INTEGER, identity_key TEXT, disabled_cause TEXT);",
    `INSERT INTO auth_credentials (provider, data, updated_at, disabled_cause) VALUES ('${provider}', '${payload}', ${Date.now()}, ${cause});`,
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
