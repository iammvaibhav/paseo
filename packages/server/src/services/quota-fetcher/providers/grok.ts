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

/** Resolve a Grok CLI token from ~/.grok/auth.json (legacy or current nested shape). */
export function extractGrokTokenFromAuth(auth: unknown): string | null {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;

  const topLevel = record["access_token"];
  if (typeof topLevel === "string" && topLevel.length > 0) {
    return topLevel;
  }

  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  const candidates = preferred.length > 0 ? preferred : entries;

  for (const [, value] of candidates) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const nestedKey = (value as Record<string, unknown>)["key"];
    if (typeof nestedKey === "string" && nestedKey.length > 0) {
      return nestedKey;
    }
  }

  return null;
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
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return unavailableUsage(this);

    const headers = {
      ...GROK_BILLING_HEADERS,
      Authorization: `Bearer ${token}`,
    };

    // Prefer the SuperGrok weekly credits view used by XAI OAuth / Grok Build CLI.
    // Fall back to monthly absolute credits when credits format is unavailable.
    const [creditsRes, monthlyRes] = await Promise.all([
      fetchProviderApi(this.fetchApi, `${GROK_BILLING_BASE}?format=credits`, { headers }),
      fetchProviderApi(this.fetchApi, GROK_BILLING_BASE, { headers }),
    ]);

    let windows: ProviderUsageWindow[] = [];
    let planLabel: string | null = null;
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
    }

    // Unified SuperGrok accounts surface weekly % as the primary meter; keep the
    // card lean (no absolute monthly bar) so it matches the SuperGrok/XAI OAuth card.
    if (windows.length > 0 && planLabel === "SuperGrok (unified)") {
      balances = [];
    }

    if (windows.length === 0 && balances.length === 0) {
      return unavailableUsage(this);
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel,
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  private async readGrokToken(): Promise<string | null> {
    // homeDir override is for tests: Windows os.homedir() ignores $HOME (uses USERPROFILE).
    const path = join(this.homeDir ?? homedir(), ".grok", "auth.json");
    if (!existsSync(path)) return null;
    try {
      return extractGrokTokenFromAuth(JSON.parse(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }
}
