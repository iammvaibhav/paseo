import { execCommand } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { OmpUsageInput } from "../shared/input.js";

const OMP_TIMEOUT_MS = 15_000;
// The registry fetches every account at once; they share one `omp usage` run.
const SNAPSHOT_TTL_MS = 10_000;

/** Runs `omp usage --json` and returns its stdout. */
export type OmpUsageRunner = () => Promise<string>;

const LimitSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.object({ shared: z.boolean().optional() }).passthrough().nullish(),
  window: z
    .object({
      id: z.string(),
      label: z.string(),
      resetsAt: z.number().nullish(),
    })
    .nullish(),
  amount: z.object({
    unit: z.string(),
    used: z.number().nullish(),
    limit: z.number().nullish(),
    remaining: z.number().nullish(),
    usedFraction: z.number().nullish(),
  }),
});

const ReportSchema = z.object({
  provider: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  limits: z.array(z.unknown()).default([]),
});

const UsageJsonSchema = z.object({ reports: z.array(ReportSchema).default([]) });

type OmpReport = z.infer<typeof ReportSchema>;
type OmpLimit = z.infer<typeof LimitSchema>;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
  "google-antigravity": "Antigravity",
  cursor: "Cursor",
  "opencode-go": "OpenCode Go",
};

const WINDOW_SHORT_LABELS: Record<string, string> = { weekly: "wk", monthly: "mo" };

const BALANCE_UNITS: Record<string, UsageBalance["unit"]> = {
  usd: "usd",
  credits: "credits",
  requests: "requests",
  tokens: "tokens",
};

async function defaultRunUsage(): Promise<string> {
  const { stdout } = await execCommand("omp", ["usage", "--json"], {
    env: process.env,
    timeout: OMP_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

let snapshot: { at: number; reports: Promise<OmpReport[]> } | null = null;

function readReports(runUsage: OmpUsageRunner, now: number): Promise<OmpReport[]> {
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.reports;
  const reports = runUsage().then((stdout) => UsageJsonSchema.parse(JSON.parse(stdout)).reports);
  snapshot = { at: now, reports };
  // A failed run must not be served to the next fetch.
  reports.catch(() => {
    if (snapshot?.reports === reports) snapshot = null;
  });
  return reports;
}

/** The login a report belongs to. Providers without an account identity have one login. */
function reportIdentity(report: OmpReport): string {
  const metadata = report.metadata ?? {};
  for (const key of ["email", "accountId", "projectId"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "default";
}

export interface OmpUsageDeps {
  runUsage?: OmpUsageRunner;
  now?: () => number;
}

export async function discover(
  scope: UsageScope,
  deps: OmpUsageDeps = {},
): Promise<UsageAccount[]> {
  if (scope.kind === "session" && scope.provider !== "omp") return [];
  let reports: OmpReport[];
  try {
    reports = await readReports(deps.runUsage ?? defaultRunUsage, (deps.now ?? Date.now)());
  } catch {
    // No omp on this host: nothing to report.
    return [];
  }
  return reports
    .filter(
      (report) =>
        scope.kind === "global" || (scope.model?.startsWith(`${report.provider}/`) ?? false),
    )
    .map((report) => {
      const identity = reportIdentity(report);
      const providerLabel = PROVIDER_LABELS[report.provider] ?? report.provider;
      const input: OmpUsageInput = { provider: report.provider, identity };
      return {
        key: hashAccountKey(`${report.provider}:${identity.toLowerCase()}`),
        label: identity === "default" ? providerLabel : `${providerLabel} · ${identity}`,
        input,
      };
    });
}

function limitWindow(limit: OmpLimit): UsageWindow {
  const { amount, window } = limit;
  let usedPct: number | null = null;
  if (typeof amount.usedFraction === "number") usedPct = amount.usedFraction * 100;
  else if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0)
    usedPct = (amount.used / amount.limit) * 100;
  else if (typeof amount.used === "number") usedPct = amount.used;
  const label =
    window && !limit.label.endsWith(window.label) ? `${limit.label} · ${window.label}` : limit.label;
  return windowFromUsedPct({
    id: limit.id,
    label,
    shortLabel: window ? (WINDOW_SHORT_LABELS[window.id] ?? window.id) : undefined,
    summary: limit.scope?.shared === true,
    utilizationPct: usedPct,
    resetsAt: window?.resetsAt ? new Date(window.resetsAt).toISOString() : null,
    tone: toneFromUsedPct(usedPct),
  });
}

export async function fetchUsage(
  input: OmpUsageInput,
  deps: OmpUsageDeps = {},
): Promise<UsageReport> {
  const reports = await readReports(
    deps.runUsage ?? defaultRunUsage,
    (deps.now ?? Date.now)(),
  );
  const report = reports.find(
    (candidate) =>
      candidate.provider === input.provider &&
      reportIdentity(candidate).toLowerCase() === input.identity.toLowerCase(),
  );
  if (!report) throw new Error("OMP no longer reports usage for this login");

  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];
  for (const raw of report.limits) {
    const parsed = LimitSchema.safeParse(raw);
    if (!parsed.success) continue;
    const limit = parsed.data;
    const balanceUnit = BALANCE_UNITS[limit.amount.unit];
    if (!balanceUnit) {
      windows.push(limitWindow(limit));
      continue;
    }
    const { used, limit: cap, remaining } = limit.amount;
    balances.push({
      id: limit.id,
      label: limit.label,
      used: used ?? null,
      limit: cap ?? null,
      remaining: remaining ?? null,
      unit: balanceUnit,
      resetsAt: limit.window?.resetsAt ? new Date(limit.window.resetsAt).toISOString() : null,
      tone: toneFromUsedPct(typeof used === "number" && cap ? (used / cap) * 100 : null),
    });
  }
  const planLabel = report.metadata?.["planType"] ?? report.metadata?.["orgName"];
  return {
    status: "available",
    ...(typeof planLabel === "string" ? { planLabel } : {}),
    windows,
    balances,
    details: [],
  };
}

/** Test seam: forget the shared `omp usage` run. */
export function resetSnapshot(): void {
  snapshot = null;
}
