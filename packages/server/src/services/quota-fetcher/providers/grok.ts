import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";
import { refreshXaiOAuthToken } from "../token-refresh.js";

const GROK_BILLING_BASE = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_BILLING_HEADERS = {
  Accept: "application/json",
  "X-XAI-Token-Auth": "xai-grok-cli",
} as const;

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      used: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      billingPeriodEnd: z.string().optional(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

// Same credits payload SuperGrok uses via OMP (`format=credits`). Grok Build CLI
// auth hits the same proxy with ~/.grok/auth.json tokens.
const GrokCreditsConfigSchema = z
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
    billingPeriodEnd: z.string().optional(),
  })
  .passthrough();

const GrokCreditsResponseSchema = z
  .object({
    config: GrokCreditsConfigSchema.nullish(),
  })
  .passthrough();

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Override home directory (tests). Production uses os.homedir(). */
  homeDir?: string;
}

export interface GrokAuthEntry {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  email?: string;
}

function parseExpiresToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Build a GrokAuthEntry from a flat record holding either access_token or key. */
function authEntryFromRecord(record: Record<string, unknown>): GrokAuthEntry | null {
  const accessToken =
    (typeof record["access_token"] === "string" && record["access_token"]) ||
    (typeof record["key"] === "string" && record["key"]) ||
    null;
  if (!accessToken) return null;
  const refreshToken =
    typeof record["refresh_token"] === "string" && record["refresh_token"].length > 0
      ? record["refresh_token"]
      : undefined;
  const expiresAtMs = parseExpiresToMs(record["expires_at"] ?? record["expires"]);
  const email = typeof record["email"] === "string" ? record["email"] : undefined;
  return { accessToken, refreshToken, expiresAtMs, email };
}

export function extractGrokAuth(auth: unknown): GrokAuthEntry | null {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;

  const topLevel = authEntryFromRecord(record);
  if (topLevel) return topLevel;

  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  const candidates = preferred.length > 0 ? preferred : entries;

  for (const [, value] of candidates) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = authEntryFromRecord(value as Record<string, unknown>);
    if (entry) return entry;
  }

  return null;
}

/** Resolve a Grok CLI token from ~/.grok/auth.json (legacy or current nested shape). */
export function extractGrokTokenFromAuth(auth: unknown): string | null {
  return extractGrokAuth(auth)?.accessToken ?? null;
}

function parseCreditsPayload(payload: unknown): {
  windows: ProviderUsageWindow[];
  planLabel: string | null;
} {
  const credits = GrokCreditsResponseSchema.parse(payload);
  const config = credits.config;
  const periodEnd = config?.currentPeriod?.end ?? config?.billingPeriodEnd;
  const resetsAt = periodEnd ? toIsoStringOrNull(Date.parse(periodEnd)) : null;
  const windows: ProviderUsageWindow[] = [];
  if (
    typeof config?.creditUsagePercent === "number" &&
    Number.isFinite(config.creditUsagePercent)
  ) {
    const usedPct = Math.max(0, Math.min(100, config.creditUsagePercent));
    windows.push(
      windowFromUsedPct({
        id: "weekly_credits",
        label: "SuperGrok Weekly Credits",
        utilizationPct: usedPct,
        resetsAt,
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }

  return {
    windows,
    planLabel: config?.isUnifiedBillingUser === true ? "SuperGrok (unified)" : null,
  };
}

function parseMonthlyBalances(payload: unknown): ProviderUsageBalance[] {
  const resp = GrokUsageResponseSchema.parse(payload);
  const monthlyLimit = resp.config?.monthlyLimit?.val ?? null;
  // Live CLI billing uses config.used.val; older mocks used usage.creditUsage.
  const creditUsage = resp.config?.used?.val ?? resp.usage?.creditUsage ?? null;
  if (monthlyLimit === null && creditUsage === null) return [];

  const remaining =
    monthlyLimit !== null && creditUsage !== null ? Math.max(0, monthlyLimit - creditUsage) : null;
  return [
    {
      id: "monthly_credits",
      label: "Monthly credits",
      used: creditUsage,
      remaining,
      limit: monthlyLimit,
      unit: "credits",
      resetsAt: resp.config?.billingPeriodEnd
        ? toIsoStringOrNull(Date.parse(resp.config.billingPeriodEnd))
        : null,
      tone: toneFromUsedPct(usedPctOf(creditUsage, monthlyLimit)),
    },
  ];
}

interface ReadGrokAuthResult {
  entry: GrokAuthEntry | null;
  error: string | null;
}

interface ParsedGrokBilling {
  windows: ProviderUsageWindow[];
  planLabel: string | null;
  balances: ProviderUsageBalance[];
  lastError: string | null;
}

export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string | undefined;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const envToken = process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"];
    let token: string | null = envToken || null;
    let authEntry: GrokAuthEntry | null = null;
    let refreshAttempted = false;
    let refreshFailed = false;

    if (!token) {
      const resolved = await this.resolveAuthEntry();
      if ("error" in resolved) {
        return unavailableUsage({
          providerId: this.providerId,
          displayName: this.displayName,
          error: resolved.error,
        });
      }
      token = resolved.token;
      authEntry = resolved.authEntry;
      refreshAttempted = resolved.refreshAttempted;
      refreshFailed = resolved.refreshFailed;
    }

    let headers = this.billingHeaders(token);
    let [creditsRes, monthlyRes] = await this.fetchBillingResponses(headers);

    // If 401 and we have a refresh token (and haven't refreshed yet), try refreshing once
    if (creditsRes.status === 401 && authEntry?.refreshToken && !refreshAttempted) {
      refreshAttempted = true;
      const refreshedToken = await this.refreshGrokAuthToken(authEntry);
      if (refreshedToken) {
        token = refreshedToken;
        headers = this.billingHeaders(refreshedToken);
        [creditsRes, monthlyRes] = await this.fetchBillingResponses(headers);
      } else {
        refreshFailed = true;
      }
    }

    const { windows, planLabel, balances, lastError } = await this.parseBillingResponses(
      creditsRes,
      monthlyRes,
    );

    if (windows.length === 0 && balances.length === 0) {
      let finalError = lastError ?? "Grok usage unavailable";
      if (refreshFailed) {
        finalError = "Grok token expired and refresh failed (re-authentication required)";
      }
      return unavailableUsage({
        providerId: this.providerId,
        displayName: this.displayName,
        error: finalError,
      });
    }

    const details = authEntry?.email
      ? [{ id: "account_email", label: "Account", value: authEntry.email }]
      : [];

    return {
      providerId: this.providerId,
      groupId: this.providerId,
      accountEmail: authEntry?.email,
      displayName: this.displayName,
      status: "available",
      planLabel,
      windows,
      balances,
      details,
      error: null,
    };
  }

  private async resolveAuthEntry(): Promise<
    | { token: string; authEntry: GrokAuthEntry; refreshAttempted: boolean; refreshFailed: boolean }
    | { error: string | null }
  > {
    const readResult = await this.readGrokAuth();
    if (!readResult.entry) {
      return { error: readResult.error };
    }
    const authEntry = readResult.entry;
    let token = authEntry.accessToken;
    let refreshAttempted = false;
    let refreshFailed = false;

    const isExpired =
      typeof authEntry.expiresAtMs === "number" && authEntry.expiresAtMs <= Date.now() + 60_000;

    if (isExpired) {
      if (!authEntry.refreshToken) {
        return {
          error: "Grok access token expired and no refresh token found in ~/.grok/auth.json",
        };
      }
      refreshAttempted = true;
      const refreshedToken = await this.refreshGrokAuthToken(authEntry);
      if (refreshedToken) {
        token = refreshedToken;
      } else {
        refreshFailed = true;
      }
    }

    return { token, authEntry, refreshAttempted, refreshFailed };
  }

  private billingHeaders(token: string): Record<string, string> {
    return {
      ...GROK_BILLING_HEADERS,
      Authorization: `Bearer ${token}`,
    };
  }

  private async fetchBillingResponses(
    headers: Record<string, string>,
  ): Promise<[Response, Response]> {
    // Prefer the SuperGrok weekly credits view used by XAI OAuth / Grok Build CLI.
    // Fall back to monthly absolute credits when credits format is unavailable.
    return Promise.all([
      fetchProviderApi(this.fetchApi, `${GROK_BILLING_BASE}?format=credits`, { headers }),
      fetchProviderApi(this.fetchApi, GROK_BILLING_BASE, { headers }),
    ]);
  }

  private async refreshGrokAuthToken(authEntry: GrokAuthEntry): Promise<string | null> {
    if (!authEntry.refreshToken) return null;
    const refreshed = await refreshXaiOAuthToken(this.fetchApi, authEntry.refreshToken);
    if (!refreshed) return null;
    authEntry.accessToken = refreshed.accessToken;
    authEntry.refreshToken = refreshed.refreshToken ?? authEntry.refreshToken;
    authEntry.expiresAtMs = refreshed.expiresAtMs;
    return refreshed.accessToken;
  }

  private async parseBillingResponses(
    creditsRes: Response,
    monthlyRes: Response,
  ): Promise<ParsedGrokBilling> {
    let windows: ProviderUsageWindow[] = [];
    let planLabel: string | null = null;
    let lastError: string | null = null;

    if (creditsRes.ok) {
      try {
        const parsed = parseCreditsPayload(await creditsRes.json());
        windows = parsed.windows;
        planLabel = parsed.planLabel;
      } catch (error) {
        this.logger.debug({ err: error }, "Grok credits payload parse failed");
      }
    } else {
      this.logger.debug({ status: creditsRes.status }, "Grok credits usage fetch failed");
      lastError = `Grok billing returned status ${creditsRes.status}`;
    }

    let balances: ProviderUsageBalance[] = [];
    if (monthlyRes.ok) {
      try {
        balances = parseMonthlyBalances(await monthlyRes.json());
      } catch (error) {
        this.logger.debug({ err: error }, "Grok monthly billing parse failed");
      }
    } else {
      this.logger.debug({ status: monthlyRes.status }, "Grok monthly usage fetch failed");
      if (!lastError) {
        lastError = `Grok monthly billing returned status ${monthlyRes.status}`;
      }
    }

    // Unified SuperGrok accounts surface weekly % as the primary meter; keep the
    // card lean (no absolute monthly bar) so it matches the SuperGrok/XAI OAuth card.
    if (windows.length > 0 && planLabel === "SuperGrok (unified)") {
      balances = [];
    }

    return { windows, planLabel, balances, lastError };
  }

  private async readGrokAuth(): Promise<ReadGrokAuthResult> {
    const path = join(this.homeDir ?? homedir(), ".grok", "auth.json");
    if (!existsSync(path)) {
      return { entry: null, error: "Grok auth missing (~/.grok/auth.json not found)" };
    }
    try {
      const raw = await fs.readFile(path, "utf8");
      const auth = JSON.parse(raw);
      const entry = extractGrokAuth(auth);
      if (!entry) {
        return { entry: null, error: "No valid Grok credentials found in ~/.grok/auth.json" };
      }
      return { entry, error: null };
    } catch {
      return { entry: null, error: "Failed to parse ~/.grok/auth.json" };
    }
  }
}
