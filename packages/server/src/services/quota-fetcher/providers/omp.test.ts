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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function canRunSqlite3(): Promise<boolean> {
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
  const payload = JSON.stringify(data).replaceAll("'", "''");
  const sql = [
    "CREATE TABLE auth_credentials (provider TEXT, data TEXT, updated_at INTEGER);",
    `INSERT INTO auth_credentials (provider, data, updated_at) VALUES ('${provider}', '${payload}', ${Date.now()});`,
  ].join("");
  await execFileAsync("sqlite3", [dbPath, sql], { timeout: 2_000 });
}

async function createEmptyAuthDb(dbPath: string): Promise<void> {
  await execFileAsync(
    "sqlite3",
    [dbPath, "CREATE TABLE auth_credentials (provider TEXT, data TEXT, updated_at INTEGER);"],
    { timeout: 2_000 },
  );
}
