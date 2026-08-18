import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  fetchProviderApi,
  toIsoStringOrNull,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
} from "../usage.js";
const execFileAsync = promisify(execFile);
const OMP_SQLITE_TIMEOUT_MS = 2_000;
const OMP_USAGE_TIMEOUT_MS = 20_000;
const CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
// AGY's Models & Quota screen uses this Cloud Code Assist endpoint. OMP's
// `omp usage` path for google-antigravity still scrapes fetchAvailableModels,
// which only exposes a single short-window counter per backend (often ~0% used
// and labeled Daily) — not the weekly + 5-hour buckets users actually hit.
const ANTIGRAVITY_QUOTA_SUMMARY_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;
const XAI_BILLING_BASE = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_BILLING_HEADERS = {
  Accept: "application/json",
  "X-XAI-Token-Auth": "xai-grok-cli",
} as const;

// OMP owns the credentials stored in agent.db, and its OAuth refresh tokens rotate
// on every use: calling a token endpoint ourselves would revoke the refresh token
// OMP has persisted and break OMP's own refresh (and the OMP CLI, which reads the
// same db). Paseo therefore NEVER refreshes OMP credentials — `omp usage --json`
// runs first, refreshes internally, and persists the rotated tokens for us. A stored
// access token is used only while it is still valid; once expired (or rejected with
// 401) the account card falls back to CLI report data, or reports the expiry.
const OMP_TOKEN_SKEW_MS = 30_000;
const OMP_TOKEN_EXPIRED_ERROR = "Token expired — will recover when OMP refreshes it";
const OMP_REAUTH_ERROR = "Token expired — re-authenticate in OMP";

const OmpOauthCredentialDataSchema = z
  .object({
    access: z.string().optional(),
    access_token: z.string().optional(),
    refresh: z.string().optional(),
    refresh_token: z.string().optional(),
    expires: ApiNumberSchema.optional(),
    expiresAt: ApiNumberSchema.optional(),
    email: z.string().optional(),
    accountId: z.string().optional(),
    projectId: z.string().optional(),
    project_id: z.string().optional(),
    orgName: z.string().optional(),
    orgId: z.string().optional(),
  })
  .passthrough();

const OmpUsageAmountSchema = z
  .object({
    unit: z.string().optional(),
    used: ApiNumberSchema.optional(),
    remaining: ApiNumberSchema.optional(),
    limit: ApiNumberSchema.optional(),
    usedFraction: ApiNumberSchema.optional(),
    remainingFraction: ApiNumberSchema.optional(),
  })
  .passthrough();

const OmpUsageLimitSchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    status: z.string().optional(),
    amount: OmpUsageAmountSchema.optional(),
    window: z
      .object({
        id: z.string().optional(),
        label: z.string().optional(),
        resetsAt: ApiNumberSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OmpUsageReportSchema = z
  .object({
    provider: z.string(),
    fetchedAt: ApiNumberSchema.optional(),
    limits: z.array(OmpUsageLimitSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const OmpUsageJsonSchema = z
  .object({
    generatedAt: ApiNumberSchema.optional(),
    reports: z.array(OmpUsageReportSchema).optional(),
    accountsWithoutUsage: z
      .array(
        z
          .object({
            provider: z.string(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const CursorUsageResponseSchema = z.object({
  billingCycleStart: z.union([z.string(), z.number()]).nullable().optional(),
  billingCycleEnd: z.union([z.string(), z.number()]).nullable().optional(),
  planUsage: z
    .object({
      totalSpend: ApiNumberSchema.nullable().optional(),
      remaining: ApiNumberSchema.nullable().optional(),
      limit: ApiNumberSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
});

const AntigravityQuotaBucketSchema = z
  .object({
    bucketId: z.string().optional(),
    displayName: z.string().optional(),
    window: z.string().optional(),
    resetTime: z.string().optional(),
    description: z.string().optional(),
    remainingFraction: ApiNumberSchema.optional(),
  })
  .passthrough();

const AntigravityQuotaGroupSchema = z
  .object({
    displayName: z.string().optional(),
    description: z.string().optional(),
    buckets: z.array(AntigravityQuotaBucketSchema).optional(),
  })
  .passthrough();

const AntigravityQuotaSummarySchema = z
  .object({
    groups: z.array(AntigravityQuotaGroupSchema).optional(),
    description: z.string().optional(),
  })
  .passthrough();

const XaiCreditsConfigSchema = z
  .object({
    currentPeriod: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        type: z.string().optional(),
      })
      .nullish(),
    creditUsagePercent: ApiNumberSchema.optional(),
    // productUsage is intentionally ignored: SuperGrok UI only shows weekly credits.
    isUnifiedBillingUser: z.boolean().optional(),
  })
  .passthrough();

const XaiCreditsResponseSchema = z
  .object({
    config: XaiCreditsConfigSchema.nullish(),
  })
  .passthrough();

export type OmpUsageCommandRunner = (args: {
  args: string[];
  timeoutMs: number;
}) => Promise<{ stdout: string; stderr: string }>;

interface OmpQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Override agent.db path (tests). */
  agentDbPath?: string;
  /** Override home directory used to resolve ~/.omp (tests). */
  homeDir?: string;
  /** Override `omp usage --json` runner (tests). */
  usageCommandRunner?: OmpUsageCommandRunner;
  /** Override omp binary path (tests/local installs). */
  ompBinary?: string;
}

interface OmpProviderIdentity {
  providerId: string;
  displayName: string;
}

export interface OmpStoredAccount {
  provider: string;
  token: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
  email: string | null;
  accountId: string | null;
  projectId: string | null;
  orgName: string | null;
  orgId: string | null;
  identityKey: string | null;
  identity: string;
  /** Set when OMP disabled the credential (e.g. after a failed refresh); its token must never be used. */
  disabledCause: string | null;
}

const OMP_PROVIDER_IDENTITIES: Record<string, OmpProviderIdentity> = {
  "xai-oauth": { providerId: "omp", displayName: "SuperGrok" },
  "grok-build": { providerId: "omp-grok-build", displayName: "Grok Build" },
  anthropic: { providerId: "omp-claude", displayName: "Claude" },
  cursor: { providerId: "omp-cursor", displayName: "Cursor" },
  "google-antigravity": {
    providerId: "omp-antigravity",
    displayName: "Antigravity",
  },
  "openai-codex": { providerId: "omp-codex", displayName: "Codex" },
  "opencode-go": { providerId: "omp-opencode-go", displayName: "OpenCode Go" },
  "opencode-zen": { providerId: "omp-opencode-zen", displayName: "OpenCode Zen" },
};
function resolveOmpAgentDbPath(homeDir: string, override?: string): string | null {
  if (override) return override;
  const fromEnv = process.env["OMP_HOME"]?.trim();
  const candidates = [
    fromEnv ? join(fromEnv, "agent", "agent.db") : null,
    join(homeDir, ".omp", "agent", "agent.db"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function titleCaseProvider(provider: string): string {
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveOmpIdentity(provider: string): OmpProviderIdentity {
  const known = OMP_PROVIDER_IDENTITIES[provider];
  if (known) return known;
  return {
    providerId: `omp-${provider}`,
    displayName: titleCaseProvider(provider),
  };
}
function resolveOmpCardIds(
  baseProviderId: string,
  emailOrIdentity: string | null,
  isMultiAccount: boolean,
): { providerId: string; groupId: string } {
  const groupId = baseProviderId;
  const providerId =
    isMultiAccount && emailOrIdentity ? `${baseProviderId}:${emailOrIdentity}` : baseProviderId;
  return { providerId, groupId };
}

function groupCliReportsByProvider(
  reports: z.infer<typeof OmpUsageReportSchema>[],
): Map<string, z.infer<typeof OmpUsageReportSchema>[]> {
  const byProvider = new Map<string, z.infer<typeof OmpUsageReportSchema>[]>();
  for (const report of reports) {
    const list = byProvider.get(report.provider) ?? [];
    list.push(report);
    byProvider.set(report.provider, list);
  }
  return byProvider;
}

function markAccountCovered(
  coveredAccounts: Map<string, Set<string>>,
  provider: string,
  identity: string,
): void {
  const set = coveredAccounts.get(provider) ?? new Set<string>();
  set.add(identity);
  coveredAccounts.set(provider, set);
}

function mapCliReportsToCards(
  cliReportsByProvider: Map<string, z.infer<typeof OmpUsageReportSchema>[]>,
  isProviderMultiAccount: (provider: string) => boolean,
): {
  cards: ProviderUsage[];
  coveredAccounts: Map<string, Set<string>>;
  pendingAgyCliCards: Map<string, ProviderUsage>;
} {
  const cards: ProviderUsage[] = [];
  const coveredAccounts = new Map<string, Set<string>>();
  const pendingAgyCliCards = new Map<string, ProviderUsage>();

  for (const [provider, reports] of cliReportsByProvider.entries()) {
    const isMulti = isProviderMultiAccount(provider);
    for (const [index, report] of reports.entries()) {
      const card = mapOmpReportToUsage(report, { isMultiAccount: isMulti, reportIndex: index });
      if (!card) continue;

      const email =
        typeof report.metadata?.email === "string" ? report.metadata.email.trim() : null;
      const accountId =
        typeof report.metadata?.accountId === "string" ? report.metadata.accountId.trim() : null;
      const identity = email || accountId || `account-${index + 1}`;
      markAccountCovered(coveredAccounts, provider, identity);
      if (email) markAccountCovered(coveredAccounts, provider, email);

      if (provider === "google-antigravity") {
        pendingAgyCliCards.set(card.providerId, card);
      } else {
        cards.push(card);
      }
    }
  }

  return { cards, coveredAccounts, pendingAgyCliCards };
}

function grokBuildErrorCard(input: {
  providerId: string;
  groupId: string;
  accountEmail: string | undefined;
  displayName: string;
  error: string;
}): ProviderUsage {
  return {
    providerId: input.providerId,
    groupId: input.groupId,
    accountEmail: input.accountEmail,
    displayName: input.displayName,
    status: "error",
    planLabel: null,
    windows: [],
    balances: [],
    details: input.accountEmail
      ? [{ id: "account_email", label: "Account", value: input.accountEmail }]
      : [],
    error: input.error,
    sourceLabel: "via OMP",
  };
}

/** Card for a stored account whose credentials are expired/rejected and the CLI had no report. */
function ompUnavailableCard(input: {
  providerId: string;
  groupId: string;
  accountEmail: string | null | undefined;
  displayName: string;
  error: string;
}): ProviderUsage {
  return {
    providerId: input.providerId,
    groupId: input.groupId,
    accountEmail: input.accountEmail ?? undefined,
    displayName: input.displayName,
    status: "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: input.accountEmail
      ? [{ id: "account_email", label: "Account", value: input.accountEmail }]
      : [],
    error: input.error,
    sourceLabel: "via OMP",
  };
}

/** Disabled-credential message; a short `disabled_cause` is appended to explain why. */
function disabledAccountError(disabledCause: string | null): string {
  const trimmed = disabledCause?.trim();
  if (trimmed && trimmed.length <= 80) {
    return `Account disabled in OMP — re-authenticate (${trimmed})`;
  }
  return "Account disabled in OMP — re-authenticate";
}

/**
 * First non-nullish value trimmed; an empty/whitespace value stops the chain
 * (mirrors `a ?? b` then `.trim() || null` semantics used across credential fields).
 */
function coalesceString(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value == null) continue;
    return value.trim() || null;
  }
  return null;
}
function percentWindow(input: {
  id: string;
  label: string;
  usagePercent: number | null | undefined;
  resetsAt: string | null;
}): ProviderUsageWindow | null {
  if (typeof input.usagePercent !== "number" || !Number.isFinite(input.usagePercent)) {
    return null;
  }
  const usedPct = Math.max(0, Math.min(100, input.usagePercent));
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: usedPct,
    resetsAt: input.resetsAt,
    tone: toneFromUsedPct(usedPct),
  });
}

function usedPctFromAmount(
  amount: z.infer<typeof OmpUsageAmountSchema> | undefined,
): number | null {
  if (!amount) return null;
  if (typeof amount.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
    return Math.max(0, amount.usedFraction * 100);
  }
  if (
    typeof amount.remainingFraction === "number" &&
    Number.isFinite(amount.remainingFraction) &&
    amount.remainingFraction >= 0 &&
    amount.remainingFraction <= 1
  ) {
    return Math.max(0, (1 - amount.remainingFraction) * 100);
  }
  return usedPctOf(amount.used, amount.limit);
}

function mapOmpLimitToWindow(
  limit: z.infer<typeof OmpUsageLimitSchema>,
): ProviderUsageWindow | null {
  const usedPct = usedPctFromAmount(limit.amount);
  if (usedPct === null) return null;
  const resetsAt =
    typeof limit.window?.resetsAt === "number" ? toIsoStringOrNull(limit.window.resetsAt) : null;
  return windowFromUsedPct({
    id: limit.id,
    label: limit.label?.trim() || limit.window?.label?.trim() || limit.id,
    utilizationPct: usedPct,
    resetsAt,
    tone: toneFromUsedPct(usedPct),
  });
}

function mapOmpLimitToBalance(
  limit: z.infer<typeof OmpUsageLimitSchema>,
): ProviderUsageBalance | null {
  const amount = limit.amount;
  if (!amount) return null;
  const unit = amount.unit?.toLowerCase();
  if (unit !== "usd" && unit !== "credits" && unit !== "requests" && unit !== "tokens") {
    return null;
  }
  const used = typeof amount.used === "number" ? amount.used : null;
  const remaining = typeof amount.remaining === "number" ? amount.remaining : null;
  const limitValue = typeof amount.limit === "number" ? amount.limit : null;
  if (used === null && remaining === null && limitValue === null) return null;
  const usedPct = usedPctFromAmount(amount);
  const resetsAt =
    typeof limit.window?.resetsAt === "number" ? toIsoStringOrNull(limit.window.resetsAt) : null;
  return {
    id: limit.id,
    label: limit.label?.trim() || limit.window?.label?.trim() || limit.id,
    used,
    remaining,
    limit: limitValue,
    unit,
    resetsAt,
    tone: toneFromUsedPct(usedPct),
  };
}

function appendOmpLimit(
  limit: z.infer<typeof OmpUsageLimitSchema>,
  isSuperGrok: boolean,
  windows: ProviderUsageWindow[],
  balances: ProviderUsageBalance[],
): void {
  // SuperGrok reports multiple sub-windows; only keep the overall weekly credits bar.
  if (isSuperGrok && limit.id !== "xai-oauth:credits:1w") {
    return;
  }
  const window = mapOmpLimitToWindow(limit);
  if (window) {
    windows.push(window);
    return;
  }
  if (isSuperGrok) return;
  const balance = mapOmpLimitToBalance(limit);
  if (balance) balances.push(balance);
}

function resolveOmpPlanLabel(metadata: Record<string, unknown> | undefined): string | null {
  if (typeof metadata?.planType === "string") return metadata.planType;
  if (typeof metadata?.billingKind !== "string") return null;
  if (metadata.billingKind === "unified") return "SuperGrok (unified)";
  return metadata.billingKind;
}

function antigravityGroupName(displayName: string | undefined): string | null {
  const rawGroupName = displayName?.trim() || null;
  if (!rawGroupName) return null;
  const lowerGroup = rawGroupName.toLowerCase();
  if (lowerGroup.includes("gemini")) return "Gemini";
  if (lowerGroup.includes("claude") || lowerGroup.includes("gpt")) return "Claude/GPT";
  return rawGroupName;
}

function antigravityBucketWindow(
  groupName: string | null,
  groupIndex: number,
  bucket: z.infer<typeof AntigravityQuotaBucketSchema>,
  bucketIndex: number,
): ProviderUsageWindow | null {
  const remainingFraction =
    typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)
      ? Math.max(0, Math.min(1, bucket.remainingFraction))
      : null;
  if (remainingFraction === null) return null;
  const usedPct = (1 - remainingFraction) * 100;
  const windowId =
    bucket.bucketId?.trim() ||
    [groupName ?? `group-${groupIndex}`, bucket.window?.trim() || `bucket-${bucketIndex}`]
      .filter(Boolean)
      .join(":");
  const resetsAt = bucket.resetTime ? toIsoStringOrNull(Date.parse(bucket.resetTime)) : null;
  const bucketLabel = bucket.displayName?.trim() || "Usage";
  return windowFromUsedPct({
    id: windowId,
    label: groupName ? `${groupName} · ${bucketLabel}` : bucketLabel,
    utilizationPct: usedPct,
    resetsAt,
    tone: toneFromUsedPct(usedPct),
  });
}

function mapAntigravityQuotaSummary(
  summary: z.infer<typeof AntigravityQuotaSummarySchema>,
  email: string | null,
  providerId: string,
  groupId: string,
  displayName: string,
): ProviderUsage | null {
  const windows: ProviderUsageWindow[] = [];
  const details: ProviderUsageDetail[] = [];

  for (const [groupIndex, group] of (summary.groups ?? []).entries()) {
    const groupName = antigravityGroupName(group.displayName);
    for (const [bucketIndex, bucket] of (group.buckets ?? []).entries()) {
      const window = antigravityBucketWindow(groupName, groupIndex, bucket, bucketIndex);
      if (window) windows.push(window);
    }
  }

  if (email) details.push({ id: "account_email", label: "Account", value: email });
  if (windows.length === 0) return null;

  return {
    providerId,
    groupId,
    accountEmail: email ?? undefined,
    displayName,
    status: "available",
    planLabel: null,
    windows,
    balances: [],
    details,
    error: null,
    sourceLabel: "via OMP",
  };
}

function mapOmpReportToUsage(
  report: z.infer<typeof OmpUsageReportSchema>,
  options: { isMultiAccount: boolean; reportIndex: number },
): ProviderUsage | null {
  const identity = resolveOmpIdentity(report.provider);
  const windows: ProviderUsageWindow[] = [];
  const balances: ProviderUsageBalance[] = [];
  const details: ProviderUsageDetail[] = [];
  const isSuperGrok = report.provider === "xai-oauth";

  for (const limit of report.limits ?? []) {
    appendOmpLimit(limit, isSuperGrok, windows, balances);
  }

  const email = typeof report.metadata?.email === "string" ? report.metadata.email.trim() : null;
  const accountId =
    typeof report.metadata?.accountId === "string" ? report.metadata.accountId.trim() : null;
  const orgName =
    typeof report.metadata?.orgName === "string" ? report.metadata.orgName.trim() : null;

  // Keep SuperGrok card lean: no account/org detail rows.
  if (!isSuperGrok) {
    if (email) details.push({ id: "account_email", label: "Account", value: email });
    if (orgName) details.push({ id: "org_name", label: "Org", value: orgName });
  }

  if (windows.length === 0 && balances.length === 0 && details.length === 0) {
    return null;
  }

  const emailOrIdentity = email || accountId || `account-${options.reportIndex + 1}`;
  const { providerId, groupId } = resolveOmpCardIds(
    identity.providerId,
    emailOrIdentity,
    options.isMultiAccount,
  );
  const displayName = identity.displayName;

  return {
    providerId,
    groupId,
    accountEmail: email ?? undefined,
    displayName,
    status: "available",
    planLabel: resolveOmpPlanLabel(report.metadata),
    windows,
    balances,
    details,
    error: null,
    sourceLabel: "via OMP",
    // Leave fetchedAt unset so ProviderUsageService stamps the list-response time.
  };
}

function parseCreditsPayload(payload: unknown): {
  windows: ProviderUsageWindow[];
  planLabel: string | null;
} {
  const credits = XaiCreditsResponseSchema.parse(payload);
  const config = credits.config;
  const resetsAt = config?.currentPeriod?.end
    ? toIsoStringOrNull(Date.parse(config.currentPeriod.end))
    : null;
  const windows: ProviderUsageWindow[] = [];
  const weekly = percentWindow({
    id: "weekly_credits",
    label: "SuperGrok Weekly Credits",
    usagePercent: config?.creditUsagePercent,
    resetsAt,
  });
  if (weekly) windows.push(weekly);

  return {
    windows,
    planLabel: config?.isUnifiedBillingUser === true ? "SuperGrok (unified)" : null,
  };
}

function centsToDollars(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : null;
}

function parseCursorBillingCycleTimestamp(
  value: string | number | null | undefined,
): string | null {
  if (value == null) return null;
  if (typeof value === "number") return toIsoStringOrNull(value);
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") return toIsoStringOrNull(asNumber);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? toIsoStringOrNull(parsed) : null;
}

async function defaultOmpUsageCommandRunner(input: {
  args: string[];
  timeoutMs: number;
  ompBinary: string;
}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(input.ompBinary, input.args, {
    timeout: input.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  return {
    stdout: String(stdout),
    stderr: String(stderr),
  };
}

function extractJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("omp usage returned empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("omp usage output was not JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
interface StatementSyncLike {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface DatabaseSyncLike {
  prepare(sql: string): StatementSyncLike;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;
}

interface RawAuthCredentialRow {
  provider: string;
  data: string;
  identity_key?: string | null;
  disabled_cause?: string | null;
}

async function queryOmpAuthCredentials(
  dbPath: string,
  logger: Logger,
): Promise<RawAuthCredentialRow[]> {
  try {
    const sqliteSpecifier: string = "node:sqlite";
    const sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    let db: DatabaseSyncLike | undefined;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare(
        "SELECT provider, data, identity_key, disabled_cause FROM auth_credentials ORDER BY updated_at DESC",
      );
      const rows = stmt.all() as unknown as RawAuthCredentialRow[];
      return rows;
    } finally {
      db?.close();
    }
  } catch (err) {
    logger.debug({ err }, "node:sqlite query failed, falling back to sqlite3 CLI");
  }

  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-json",
        dbPath,
        "SELECT provider, data, identity_key, disabled_cause FROM auth_credentials ORDER BY updated_at DESC;",
      ],
      { timeout: OMP_SQLITE_TIMEOUT_MS },
    );
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as RawAuthCredentialRow[];
  } catch (err) {
    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        [
          dbPath,
          "SELECT json_group_array(json_object('provider', provider, 'data', data, 'identity_key', identity_key, 'disabled_cause', disabled_cause)) FROM auth_credentials ORDER BY updated_at DESC;",
        ],
        { timeout: OMP_SQLITE_TIMEOUT_MS },
      );
      const raw = stdout.trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as RawAuthCredentialRow[];
      }
    } catch {
      logger.debug({ err, dbPath }, "OMP agent.db read failed via sqlite3 CLI");
    }
  }

  return [];
}

export class OmpQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "omp";
  readonly agentProviderIds: readonly string[] = ["omp"];
  readonly displayName = "OMP";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly agentDbPath?: string;
  private readonly homeDir: string;
  private readonly usageCommandRunner: OmpUsageCommandRunner;
  private readonly ompBinary: string;

  constructor(options: OmpQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.agentDbPath = options.agentDbPath;
    this.homeDir = options.homeDir ?? homedir();
    this.ompBinary = options.ompBinary ?? (process.env["OMP_BIN"]?.trim() || "omp");
    this.usageCommandRunner =
      options.usageCommandRunner ??
      ((input) =>
        defaultOmpUsageCommandRunner({
          args: input.args,
          timeoutMs: input.timeoutMs,
          ompBinary: this.ompBinary,
        }));
  }

  async fetchUsage(): Promise<ProviderUsage | ProviderUsage[]> {
    const usages: ProviderUsage[] = [];
    const seen = new Set<string>();

    const pushUsage = (usage: ProviderUsage | null | undefined) => {
      if (!usage) return;
      if (seen.has(usage.providerId)) return;
      if (
        usage.status === "available" &&
        usage.windows.length === 0 &&
        (usage.balances?.length ?? 0) === 0 &&
        (usage.details?.length ?? 0) === 0
      ) {
        return;
      }
      seen.add(usage.providerId);
      usages.push(usage);
    };

    const storedAccounts = await this.readAllOmpAccounts();
    const cliResult = await this.fetchFromOmpUsageReports();
    const cliReports = cliResult.reports;
    const cliReportsByProvider = groupCliReportsByProvider(cliReports);
    const providerAccountCounts = this.computeProviderAccountCounts(
      storedAccounts,
      cliReportsByProvider,
    );
    const isProviderMultiAccount = (provider: string): boolean => {
      return (providerAccountCounts.get(provider) ?? 0) > 1;
    };
    // When the CLI itself failed to authenticate a provider, its own refresh could
    // not help either: tell the user to re-authenticate instead of to wait.
    const expiredErrorFor = (provider: string): string =>
      cliResult.authFailureProviders.has(provider) ? OMP_REAUTH_ERROR : OMP_TOKEN_EXPIRED_ERROR;

    const { cards, coveredAccounts, pendingAgyCliCards } = mapCliReportsToCards(
      cliReportsByProvider,
      isProviderMultiAccount,
    );
    for (const card of cards) {
      pushUsage(card);
    }

    // Disabled accounts (OMP set a disabled_cause) must never vanish from the list
    // or have their token used: surface an unavailable card unless the CLI reported
    // fresh data for the account, in which case the CLI card wins.
    await this.pushDisabledAccountCards(
      storedAccounts,
      coveredAccounts,
      isProviderMultiAccount,
      pushUsage,
    );

    // Antigravity: try direct Cloud Code summary per account, falling back to the
    // CLI card for any account the direct fetch misses.
    await this.pushAntigravityCards(
      storedAccounts,
      pendingAgyCliCards,
      isProviderMultiAccount,
      expiredErrorFor,
      pushUsage,
    );

    // Direct-API fallbacks for stored accounts the CLI did not report on. These run
    // only with a still-valid token; on 401 they never refresh — the account card
    // falls back to CLI report data, or reports the expiry.
    await this.pushFallbackAccountCards(
      storedAccounts.get("cursor") ?? [],
      isProviderMultiAccount("cursor"),
      coveredAccounts,
      "cursor",
      (account, multi) =>
        this.fetchCursorUsageForAccount(account, multi, expiredErrorFor("cursor")),
      pushUsage,
    );
    await this.pushFallbackAccountCards(
      storedAccounts.get("xai-oauth") ?? [],
      isProviderMultiAccount("xai-oauth"),
      coveredAccounts,
      "xai-oauth",
      (account, multi) =>
        this.fetchSuperGrokUsageForAccount(account, multi, expiredErrorFor("xai-oauth")),
      pushUsage,
    );
    await this.pushFallbackAccountCards(
      storedAccounts.get("grok-build") ?? [],
      isProviderMultiAccount("grok-build"),
      coveredAccounts,
      "grok-build",
      (account, multi) =>
        this.fetchGrokBuildUsageForAccount(account, multi, expiredErrorFor("grok-build")),
      pushUsage,
    );

    if (usages.length === 0) {
      return unavailableUsage(this);
    }
    return usages.length === 1 ? usages[0]! : usages;
  }

  private async fetchFromOmpUsageReports(): Promise<{
    reports: z.infer<typeof OmpUsageReportSchema>[];
    authFailureProviders: Set<string>;
  }> {
    try {
      const { stdout } = await this.usageCommandRunner({
        args: ["usage", "--json"],
        timeoutMs: OMP_USAGE_TIMEOUT_MS,
      });
      const parsed = OmpUsageJsonSchema.parse(extractJsonObject(stdout));
      const authFailureProviders = new Set<string>();
      for (const entry of parsed.accountsWithoutUsage ?? []) {
        const record = entry as Record<string, unknown>;
        const reportsAuthFailure = ["error", "reason", "message"].some(
          (key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0,
        );
        if (reportsAuthFailure) authFailureProviders.add(entry.provider);
      }
      return { reports: parsed.reports ?? [], authFailureProviders };
    } catch (error) {
      this.logger.debug({ err: error }, "OMP usage CLI fetch failed");
      return { reports: [], authFailureProviders: new Set() };
    }
  }

  private async fetchCursorUsageForAccount(
    account: OmpStoredAccount,
    isMultiAccount: boolean,
    expiredError: string,
  ): Promise<ProviderUsage | null> {
    const identity = resolveOmpIdentity("cursor");
    const emailOrIdentity = account.email || account.accountId || account.identity;
    const { providerId, groupId } = resolveOmpCardIds(
      identity.providerId,
      emailOrIdentity,
      isMultiAccount,
    );
    const displayName = identity.displayName;

    const { token, expired, disabled } = this.resolveAccountAccessToken(account);
    if (disabled) {
      // Emitted as an "Account disabled in OMP" card by pushDisabledAccountCards.
      return null;
    }
    if (!token) {
      return ompUnavailableCard({
        providerId,
        groupId,
        accountEmail: account.email,
        displayName,
        error: expired ? expiredError : OMP_REAUTH_ERROR,
      });
    }

    try {
      const res = await fetchProviderApi(this.fetchApi, CURSOR_USAGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({}),
      });
      if (res.status === 401) {
        // Never refresh OMP-owned credentials; surface the rejection instead.
        return ompUnavailableCard({
          providerId,
          groupId,
          accountEmail: account.email,
          displayName,
          error: expiredError,
        });
      }
      if (!res.ok) {
        this.logger.debug({ status: res.status }, "OMP Cursor usage fetch failed");
        return null;
      }

      const resp = CursorUsageResponseSchema.parse(await res.json());
      const billingCycleEnd = parseCursorBillingCycleTimestamp(resp.billingCycleEnd);
      const balances: ProviderUsageBalance[] = [];
      if (resp.planUsage) {
        const totalSpend = centsToDollars(resp.planUsage.totalSpend ?? null);
        const remaining = centsToDollars(resp.planUsage.remaining ?? null);
        const limit = centsToDollars(resp.planUsage.limit ?? null);
        balances.push({
          id: "plan_usage",
          label: "Plan usage",
          used: totalSpend,
          remaining,
          limit,
          unit: "usd",
          resetsAt: billingCycleEnd,
          tone: toneFromUsedPct(usedPctOf(totalSpend, limit)),
        });
      }

      if (balances.length === 0) return null;
      const details: ProviderUsageDetail[] = [];
      if (account.email) {
        details.push({ id: "account_email", label: "Account", value: account.email });
      }

      return {
        providerId,
        groupId,
        accountEmail: account.email ?? undefined,
        displayName,
        status: "available",
        planLabel: null,
        windows: [],
        balances,
        details,
        error: null,
        sourceLabel: "via OMP",
      };
    } catch (error) {
      this.logger.debug({ err: error }, "OMP Cursor usage parse failed");
      return null;
    }
  }

  private async fetchAntigravityUsageForAccount(
    account: OmpStoredAccount,
    isMultiAccount: boolean,
  ): Promise<ProviderUsage | null> {
    const identity = resolveOmpIdentity("google-antigravity");
    const emailOrIdentity = account.email || account.accountId || account.identity;
    const { providerId, groupId } = resolveOmpCardIds(
      identity.providerId,
      emailOrIdentity,
      isMultiAccount,
    );
    const displayName = identity.displayName;

    const { token } = this.resolveAccountAccessToken(account);
    if (!token) return null;

    const projectId = account.projectId;
    const body = projectId ? JSON.stringify({ project: projectId }) : JSON.stringify({});

    for (const url of ANTIGRAVITY_QUOTA_SUMMARY_URLS) {
      try {
        const res = await fetchProviderApi(this.fetchApi, url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity",
          },
          body,
        });
        if (res.status === 401) {
          // Never refresh OMP-owned credentials; the CLI-card fallback (or an
          // unavailable card) below reports the rejection.
          this.logger.debug({ status: res.status, url }, "OMP Antigravity token rejected");
          return null;
        }
        if (!res.ok) {
          this.logger.debug(
            { status: res.status, url },
            "OMP Antigravity quota summary fetch failed",
          );
          continue;
        }
        const summary = AntigravityQuotaSummarySchema.parse(await res.json());
        const usage = mapAntigravityQuotaSummary(
          summary,
          account.email,
          providerId,
          groupId,
          displayName,
        );
        if (usage) return usage;
      } catch (error) {
        this.logger.debug({ err: error, url }, "OMP Antigravity quota summary parse failed");
      }
    }
    return null;
  }

  private async fetchXaiCredits(token: string): Promise<Response> {
    return fetchProviderApi(this.fetchApi, `${XAI_BILLING_BASE}?format=credits`, {
      headers: { ...XAI_BILLING_HEADERS, Authorization: `Bearer ${token}` },
    });
  }

  private async fetchSuperGrokUsageForAccount(
    account: OmpStoredAccount,
    isMultiAccount: boolean,
    expiredError: string,
  ): Promise<ProviderUsage | null> {
    const identity = resolveOmpIdentity("xai-oauth");
    const emailOrIdentity = account.email || account.accountId || account.identity;
    const { providerId, groupId } = resolveOmpCardIds(
      identity.providerId,
      emailOrIdentity,
      isMultiAccount,
    );
    const displayName = identity.displayName;

    const { token, expired, disabled } = this.resolveAccountAccessToken(account);
    if (disabled) {
      // Emitted as an "Account disabled in OMP" card by pushDisabledAccountCards.
      return null;
    }
    if (!token) {
      return ompUnavailableCard({
        providerId,
        groupId,
        accountEmail: account.email,
        displayName,
        error: expired ? expiredError : OMP_REAUTH_ERROR,
      });
    }

    try {
      const creditsRes = await this.fetchXaiCredits(token);
      if (creditsRes.status === 401) {
        // Never refresh OMP-owned credentials; surface the rejection instead.
        return ompUnavailableCard({
          providerId,
          groupId,
          accountEmail: account.email,
          displayName,
          error: expiredError,
        });
      }
      if (!creditsRes.ok) {
        this.logger.debug({ creditsStatus: creditsRes.status }, "OMP SuperGrok usage fetch failed");
        return null;
      }

      const parsed = parseCreditsPayload(await creditsRes.json());
      if (parsed.windows.length === 0) return null;

      return {
        providerId,
        groupId,
        accountEmail: account.email ?? undefined,
        displayName,
        status: "available",
        planLabel: parsed.planLabel ?? "SuperGrok",
        windows: parsed.windows,
        balances: [],
        details: [],
        error: null,
        sourceLabel: "via OMP",
      };
    } catch (err) {
      this.logger.debug({ err }, "OMP SuperGrok credits fetch failed");
      return null;
    }
  }

  private async fetchGrokBuildUsageForAccount(
    account: OmpStoredAccount,
    isMultiAccount: boolean,
    expiredError: string,
  ): Promise<ProviderUsage | null> {
    const identity = resolveOmpIdentity("grok-build");
    const emailOrIdentity = account.email || account.accountId || account.identity;
    const { providerId, groupId } = resolveOmpCardIds(
      identity.providerId,
      emailOrIdentity,
      isMultiAccount,
    );
    const displayName = identity.displayName;

    const { token, expired, disabled } = this.resolveAccountAccessToken(account);
    if (disabled) {
      // Emitted as an "Account disabled in OMP" card by pushDisabledAccountCards.
      return null;
    }
    if (!token) {
      return ompUnavailableCard({
        providerId,
        groupId,
        accountEmail: account.email,
        displayName,
        error: expired ? expiredError : OMP_REAUTH_ERROR,
      });
    }

    try {
      const creditsRes = await this.fetchXaiCredits(token);
      if (creditsRes.status === 401) {
        // Never refresh OMP-owned credentials; surface the rejection instead.
        return ompUnavailableCard({
          providerId,
          groupId,
          accountEmail: account.email,
          displayName,
          error: expiredError,
        });
      }
      if (!creditsRes.ok) {
        return grokBuildErrorCard({
          providerId,
          groupId,
          accountEmail: account.email ?? undefined,
          displayName,
          error: `Grok Build billing returned status ${creditsRes.status}`,
        });
      }

      const parsed = parseCreditsPayload(await creditsRes.json());
      const details: ProviderUsageDetail[] = [];
      if (account.email) {
        details.push({ id: "account_email", label: "Account", value: account.email });
      }

      return {
        providerId,
        groupId,
        accountEmail: account.email ?? undefined,
        displayName,
        status: "available",
        planLabel: parsed.planLabel ?? "Grok Build",
        windows: parsed.windows,
        balances: [],
        details,
        error: null,
        sourceLabel: "via OMP",
      };
    } catch (err) {
      return grokBuildErrorCard({
        providerId,
        groupId,
        accountEmail: account.email ?? undefined,
        displayName,
        error: `Grok Build billing fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private parseStoredAccountRow(row: RawAuthCredentialRow, index: number): OmpStoredAccount | null {
    try {
      const data = OmpOauthCredentialDataSchema.parse(JSON.parse(row.data));
      const email = coalesceString(data.email);
      const accountId = coalesceString(data.accountId);
      const identityKeySuffix = coalesceString(row.identity_key?.replace(/^[^:]+:/, ""));
      const expires = data.expires ?? data.expiresAt;
      const expiresAtMs = typeof expires === "number" && Number.isFinite(expires) ? expires : null;
      return {
        provider: row.provider,
        token: coalesceString(data.access, data.access_token),
        refreshToken: coalesceString(data.refresh, data.refresh_token),
        expiresAtMs,
        email,
        accountId,
        projectId: coalesceString(data.projectId, data.project_id),
        orgName: coalesceString(data.orgName),
        orgId: coalesceString(data.orgId),
        identityKey: row.identity_key ?? null,
        identity: coalesceString(email, accountId, identityKeySuffix) ?? `account-${index + 1}`,
        disabledCause: coalesceString(row.disabled_cause),
      };
    } catch (error) {
      this.logger.debug(
        { err: error, provider: row.provider },
        "Failed to parse auth_credentials row",
      );
      return null;
    }
  }

  private async readAllOmpAccounts(): Promise<Map<string, OmpStoredAccount[]>> {
    const dbPath = resolveOmpAgentDbPath(this.homeDir, this.agentDbPath);
    if (!dbPath) return new Map();

    const rows = await queryOmpAuthCredentials(dbPath, this.logger);
    const byProvider = new Map<string, OmpStoredAccount[]>();

    for (const [index, row] of rows.entries()) {
      const account = this.parseStoredAccountRow(row, index);
      if (!account) continue;
      const existing = byProvider.get(row.provider) ?? [];
      existing.push(account);
      byProvider.set(row.provider, existing);
    }

    return byProvider;
  }

  private computeProviderAccountCounts(
    storedAccounts: Map<string, OmpStoredAccount[]>,
    cliReportsByProvider: Map<string, z.infer<typeof OmpUsageReportSchema>[]>,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [provider, accounts] of storedAccounts.entries()) {
      counts.set(provider, accounts.length);
    }
    for (const [provider, reports] of cliReportsByProvider.entries()) {
      const prev = counts.get(provider) ?? 0;
      counts.set(provider, Math.max(prev, reports.length));
    }
    return counts;
  }

  private isStoredAccountCovered(
    coveredAccounts: Map<string, Set<string>>,
    provider: string,
    account: OmpStoredAccount,
  ): boolean {
    const emailOrIdentity = account.email || account.accountId || account.identity;
    if (coveredAccounts.get(provider)?.has(emailOrIdentity)) return true;
    return account.email ? (coveredAccounts.get(provider)?.has(account.email) ?? false) : false;
  }

  private async pushDisabledAccountCards(
    storedAccounts: Map<string, OmpStoredAccount[]>,
    coveredAccounts: Map<string, Set<string>>,
    isProviderMultiAccount: (provider: string) => boolean,
    push: (usage: ProviderUsage | null | undefined) => void,
  ): Promise<void> {
    for (const [provider, accounts] of storedAccounts.entries()) {
      const isMulti = isProviderMultiAccount(provider);
      for (const account of accounts) {
        if (account.disabledCause === null) continue;
        if (this.isStoredAccountCovered(coveredAccounts, provider, account)) continue;
        const identity = resolveOmpIdentity(provider);
        const emailOrIdentity = account.email || account.accountId || account.identity;
        const { providerId, groupId } = resolveOmpCardIds(
          identity.providerId,
          emailOrIdentity,
          isMulti,
        );
        push(
          ompUnavailableCard({
            providerId,
            groupId,
            accountEmail: account.email,
            displayName: identity.displayName,
            error: disabledAccountError(account.disabledCause),
          }),
        );
      }
    }
  }

  private async pushFallbackAccountCards(
    accounts: OmpStoredAccount[],
    isMultiAccount: boolean,
    coveredAccounts: Map<string, Set<string>>,
    provider: string,
    fetchOne: (account: OmpStoredAccount, multi: boolean) => Promise<ProviderUsage | null>,
    push: (usage: ProviderUsage | null | undefined) => void,
  ): Promise<void> {
    for (const account of accounts) {
      if (this.isStoredAccountCovered(coveredAccounts, provider, account)) continue;
      push(await fetchOne(account, isMultiAccount));
    }
  }

  private async pushAntigravityCards(
    storedAccounts: Map<string, OmpStoredAccount[]>,
    pendingAgyCliCards: Map<string, ProviderUsage>,
    isProviderMultiAccount: (provider: string) => boolean,
    expiredErrorFor: (provider: string) => string,
    push: (usage: ProviderUsage | null | undefined) => void,
  ): Promise<void> {
    const agyAccounts = storedAccounts.get("google-antigravity") ?? [];
    const isAgyMulti = isProviderMultiAccount("google-antigravity");
    if (agyAccounts.length === 0) {
      for (const card of pendingAgyCliCards.values()) {
        push(card);
      }
      return;
    }
    for (const account of agyAccounts) {
      const summary = await this.fetchAntigravityUsageForAccount(account, isAgyMulti);
      if (summary) {
        push(summary);
        continue;
      }
      const emailOrIdentity = account.email || account.accountId || account.identity;
      const { providerId } = resolveOmpCardIds("omp-antigravity", emailOrIdentity, isAgyMulti);
      const cliCard = pendingAgyCliCards.get(providerId);
      if (cliCard) {
        push(cliCard);
        continue;
      }
      push(
        ompUnavailableCard({
          providerId,
          groupId: "omp-antigravity",
          accountEmail: account.email,
          displayName: resolveOmpIdentity("google-antigravity").displayName,
          error: expiredErrorFor("google-antigravity"),
        }),
      );
    }
  }

  /**
   * OMP-owned access tokens are used only while still valid (expiresAtMs in the
   * future, with a small skew tolerance). There is deliberately no refresh path:
   * OMP's refresh tokens rotate on use, so refreshing here would revoke the token
   * OMP has persisted in agent.db and break OMP's own refresh. Disabled accounts
   * never yield a token at all.
   */
  private resolveAccountAccessToken(account: OmpStoredAccount): {
    token: string | null;
    disabled: boolean;
    expired: boolean;
  } {
    if (account.disabledCause !== null) {
      return { token: null, disabled: true, expired: false };
    }
    const now = Date.now();
    const isExpired =
      account.expiresAtMs !== null && account.expiresAtMs <= now + OMP_TOKEN_SKEW_MS;
    if (account.token && !isExpired) {
      return { token: account.token, disabled: false, expired: false };
    }
    return { token: null, disabled: false, expired: isExpired };
  }
}
