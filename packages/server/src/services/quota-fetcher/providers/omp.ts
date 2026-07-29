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
const XAI_BILLING_BASE = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_BILLING_HEADERS = {
  Accept: "application/json",
  "X-XAI-Token-Auth": "xai-grok-cli",
} as const;

const OmpOauthCredentialDataSchema = z.object({
  access: z.string().optional(),
  access_token: z.string().optional(),
  expires: ApiNumberSchema.optional(),
  expiresAt: ApiNumberSchema.optional(),
  email: z.string().optional(),
  accountId: z.string().optional(),
});

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

const OMP_PROVIDER_IDENTITIES: Record<string, OmpProviderIdentity> = {
  "xai-oauth": { providerId: "omp", displayName: "OMP · SuperGrok" },
  "grok-build": { providerId: "omp-grok-build", displayName: "OMP · Grok Build" },
  anthropic: { providerId: "omp-claude", displayName: "OMP · Claude" },
  cursor: { providerId: "omp-cursor", displayName: "OMP · Cursor" },
  "google-antigravity": {
    providerId: "omp-antigravity",
    displayName: "OMP · Antigravity",
  },
  "openai-codex": { providerId: "omp-codex", displayName: "OMP · Codex" },
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

function resolveOmpIdentity(provider: string): OmpProviderIdentity {
  const known = OMP_PROVIDER_IDENTITIES[provider];
  if (known) return known;
  return {
    providerId: `omp-${provider}`,
    displayName: `OMP · ${provider}`,
  };
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

function mapOmpReportToUsage(report: z.infer<typeof OmpUsageReportSchema>): ProviderUsage | null {
  const identity = resolveOmpIdentity(report.provider);
  const windows: ProviderUsageWindow[] = [];
  const balances: ProviderUsageBalance[] = [];
  const details: ProviderUsageDetail[] = [];
  const isSuperGrok = report.provider === "xai-oauth";

  for (const limit of report.limits ?? []) {
    appendOmpLimit(limit, isSuperGrok, windows, balances);
  }

  // Keep SuperGrok card lean: no account/org detail rows.
  if (!isSuperGrok) {
    const email = typeof report.metadata?.email === "string" ? report.metadata.email : null;
    const orgName = typeof report.metadata?.orgName === "string" ? report.metadata.orgName : null;
    if (email) details.push({ id: "account_email", label: "Account", value: email });
    if (orgName) details.push({ id: "org_name", label: "Org", value: orgName });
  }

  if (windows.length === 0 && balances.length === 0 && details.length === 0) {
    return null;
  }

  return {
    providerId: identity.providerId,
    displayName: identity.displayName,
    status: "available",
    planLabel: resolveOmpPlanLabel(report.metadata),
    windows,
    balances,
    details,
    error: null,
    sourceLabel: "via OMP",
    fetchedAt:
      typeof report.fetchedAt === "number" ? toIsoStringOrNull(report.fetchedAt) : undefined,
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

export class OmpQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "omp";
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
      if (usage.status !== "available") return;
      if (
        usage.windows.length === 0 &&
        (usage.balances?.length ?? 0) === 0 &&
        (usage.details?.length ?? 0) === 0
      ) {
        return;
      }
      seen.add(usage.providerId);
      usages.push(usage);
    };

    for (const usage of await this.fetchFromOmpUsageCommand()) {
      pushUsage(usage);
    }

    // OMP currently authenticates Cursor but does not expose a usage endpoint through
    // `omp usage`. Fall back to Cursor's dashboard API using the stored OMP credential.
    if (!seen.has("omp-cursor")) {
      pushUsage(await this.fetchCursorUsageFromOmpAuth());
    }

    // If the CLI path failed entirely, keep SuperGrok via the original SQLite+billing path.
    if (!seen.has("omp")) {
      pushUsage(await this.fetchSuperGrokUsageFromOmpAuth());
    }

    if (usages.length === 0) {
      return unavailableUsage(this);
    }
    return usages.length === 1 ? usages[0]! : usages;
  }

  private async fetchFromOmpUsageCommand(): Promise<ProviderUsage[]> {
    try {
      const { stdout } = await this.usageCommandRunner({
        args: ["usage", "--json"],
        timeoutMs: OMP_USAGE_TIMEOUT_MS,
      });
      const parsed = OmpUsageJsonSchema.parse(extractJsonObject(stdout));
      const usages: ProviderUsage[] = [];
      for (const report of parsed.reports ?? []) {
        const usage = mapOmpReportToUsage(report);
        if (usage) usages.push(usage);
      }
      return usages;
    } catch (error) {
      this.logger.debug({ err: error }, "OMP usage CLI fetch failed");
      return [];
    }
  }

  private async fetchCursorUsageFromOmpAuth(): Promise<ProviderUsage | null> {
    const token = await this.readOmpOauthAccessToken("cursor");
    if (!token) return null;

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
      const identity = resolveOmpIdentity("cursor");
      return {
        providerId: identity.providerId,
        displayName: identity.displayName,
        status: "available",
        planLabel: null,
        windows: [],
        balances,
        details: [],
        error: null,
        sourceLabel: "Cursor via OMP auth",
      };
    } catch (error) {
      this.logger.debug({ err: error }, "OMP Cursor usage parse failed");
      return null;
    }
  }

  private async fetchSuperGrokUsageFromOmpAuth(): Promise<ProviderUsage | null> {
    const token = await this.readOmpOauthAccessToken("xai-oauth");
    if (!token) return null;

    const headers = {
      ...XAI_BILLING_HEADERS,
      Authorization: `Bearer ${token}`,
    };
    const creditsRes = await fetchProviderApi(this.fetchApi, `${XAI_BILLING_BASE}?format=credits`, {
      headers,
    });

    if (!creditsRes.ok) {
      this.logger.debug({ creditsStatus: creditsRes.status }, "OMP SuperGrok usage fetch failed");
      return null;
    }

    const windows: ProviderUsageWindow[] = [];
    let planLabel: string | null = "SuperGrok";

    try {
      const parsed = parseCreditsPayload(await creditsRes.json());
      windows.push(...parsed.windows);
      if (parsed.planLabel) planLabel = parsed.planLabel;
    } catch (error) {
      this.logger.debug({ err: error }, "OMP SuperGrok credits payload parse failed");
    }

    if (windows.length === 0) {
      return null;
    }

    return {
      providerId: "omp",
      displayName: "OMP · SuperGrok",
      status: "available",
      planLabel,
      windows,
      balances: [],
      details: [],
      error: null,
      sourceLabel: "SuperGrok via OMP auth",
    };
  }

  private async readOmpOauthAccessToken(provider: string): Promise<string | null> {
    const dbPath = resolveOmpAgentDbPath(this.homeDir, this.agentDbPath);
    if (!dbPath) return null;

    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        [
          dbPath,
          `SELECT data FROM auth_credentials WHERE provider = '${provider.replaceAll("'", "''")}' ORDER BY updated_at DESC LIMIT 1;`,
        ],
        { timeout: OMP_SQLITE_TIMEOUT_MS },
      );
      const raw = stdout.trim();
      if (!raw) return null;
      const data = OmpOauthCredentialDataSchema.parse(JSON.parse(raw));
      const token = (data.access ?? data.access_token)?.trim();
      if (!token) return null;
      const expiresAt = data.expires ?? data.expiresAt;
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return null;
      }
      return token;
    } catch (error) {
      this.logger.debug({ err: error, dbPath, provider }, "OMP OAuth token read failed");
      return null;
    }
  }
}
