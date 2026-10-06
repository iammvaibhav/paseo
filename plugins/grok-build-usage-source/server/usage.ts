import { execCommand } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { GrokBuildUsageInput } from "../shared/input.js";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OMP_PROVIDER = "grok-build";
const OMP_TIMEOUT_MS = 15_000;

/** Runs `omp` with the given arguments and returns its stdout. */
export type OmpRunner = (args: string[]) => Promise<string>;

export interface GrokBuildUsageDeps {
  runOmp?: OmpRunner;
  fetchApi?: typeof fetch;
}

const ApiNumberSchema = z.coerce.number().finite();

const CreditsResponseSchema = z.object({
  config: z
    .object({
      creditUsagePercent: ApiNumberSchema.optional(),
      isUnifiedBillingUser: z.boolean().optional(),
      currentPeriod: z
        .object({
          type: z.string().nullish(),
          end: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

async function defaultRunOmp(args: string[]): Promise<string> {
  const { stdout } = await execCommand("omp", args, {
    env: process.env,
    timeout: OMP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * `omp token grok-build --list` prints one "N. identity" line per login, in the
 * order `--account N` resolves. The list covers broker-backed logins that have
 * no row in the local agent.db.
 */
export function parseAccountList(stdout: string): { number: number; identity: string }[] {
  const entries: { number: number; identity: string }[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s*[.):-]\s*(.+?)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    entries.push({ number: Number(match[1]), identity: match[2] });
  }
  return entries;
}

async function listAccounts(runOmp: OmpRunner): Promise<{ number: number; identity: string }[]> {
  try {
    return parseAccountList(await runOmp(["token", OMP_PROVIDER, "--list"]));
  } catch {
    // No omp on this host, or no Grok Build login: nothing to report.
    return [];
  }
}

export async function discover(
  scope: UsageScope,
  deps: GrokBuildUsageDeps = {},
): Promise<UsageAccount[]> {
  // A session reports Grok Build usage only while an OMP agent runs a Grok Build model.
  if (
    scope.kind === "session" &&
    (scope.provider !== "omp" || !scope.model?.startsWith(`${OMP_PROVIDER}/`))
  ) {
    return [];
  }
  const accounts = await listAccounts(deps.runOmp ?? defaultRunOmp);
  return accounts.map(({ identity }) => {
    const input: GrokBuildUsageInput = { identity };
    return {
      key: hashAccountKey(`${OMP_PROVIDER}:${identity.toLowerCase()}`),
      label: identity,
      input,
    };
  });
}

function creditsWindow(
  config: NonNullable<z.infer<typeof CreditsResponseSchema>["config"]>,
): UsageWindow {
  // proto3 JSON omits zero-valued scalars: an absent percent on a present config is 0% used.
  const percent = config.creditUsagePercent ?? 0;
  const period = config.currentPeriod;
  const names = {
    USAGE_PERIOD_TYPE_WEEKLY: { id: "weekly", label: "Weekly", shortLabel: "wk" },
    USAGE_PERIOD_TYPE_MONTHLY: { id: "monthly", label: "Monthly", shortLabel: "mo" },
  };
  const name = names[period?.type as keyof typeof names] ?? {
    id: `period:${period?.type || "unknown"}`,
    label: period?.type || "Current period",
    shortLabel: "",
  };
  return windowFromUsedPct({
    ...name,
    summary: true,
    utilizationPct: percent,
    resetsAt: period?.end ?? null,
    tone: toneFromUsedPct(percent),
  });
}

export async function fetchUsage(
  input: GrokBuildUsageInput,
  deps: GrokBuildUsageDeps = {},
): Promise<UsageReport> {
  const runOmp = deps.runOmp ?? defaultRunOmp;
  const fetchApi = deps.fetchApi ?? fetch;
  // Account numbers follow OMP's stored order, so resolve the identity each time.
  const account = (await listAccounts(runOmp)).find(
    (entry) => entry.identity.toLowerCase() === input.identity.toLowerCase(),
  );
  if (!account) throw new Error("Grok Build login is no longer listed by OMP");
  // OMP refreshes an expired token itself and owns the rotated write.
  const tokenOutput = await runOmp(["token", OMP_PROVIDER, "--account", String(account.number)]);
  const token = tokenOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!token) throw new Error("OMP returned no Grok Build token");

  const res = await fetchApi(BILLING_URL, {
    signal: AbortSignal.timeout(OMP_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
  });
  if (res.status === 401 || res.status === 403) {
    return unavailable({ kind: "rejected", status: res.status, refreshedBy: "omp" });
  }
  if (!res.ok) throw new Error(`Grok Build billing returned ${res.status}`);

  const { config } = CreditsResponseSchema.parse(await res.json());
  return {
    status: "available",
    ...(config?.isUnifiedBillingUser ? { planLabel: "Grok Build" } : {}),
    windows: config ? [creditsWindow(config)] : [],
    balances: [],
    details: [],
  };
}
