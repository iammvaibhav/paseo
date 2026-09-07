/**
 * omp-account-routing — per-host / per-project OAuth account routing for Oh My Pi.
 *
 * Why this exists: omp rotates multiple OAuth accounts per provider by usage
 * headroom with per-session stickiness, but there is no way to say "this
 * project must use account X" or "use ambient first, fall back to personal".
 * This extension adds that control:
 *
 *   - host config   ~/.omp/agent/account-routing.yml     (alias → account map, defaults)
 *   - project config .omp/account-routing.yml            (per-provider strategy/order/enabled)
 *
 * Enforcement uses the native session pin (`AuthStorage.pinSessionOAuthAccount`)
 * keyed on the session manager's session id — the id request-time key
 * resolution uses for a normally-booted session (`AgentSession.sessionId` →
 * `#activeProviderSessionId()` falls through to it). OAuth refresh, broker
 * proxying, usage attribution and the `/session` account UI all keep working.
 * A runtime API-key override would enforce too, but it makes omp report auth as
 * `--api-key`, empties `listOAuthAccounts`, and blocks manual pinning — so it is
 * deliberately NOT used. No config → no-op.
 *
 * Known gap: `omp -p` (print mode), `/fresh`, and `/reset` mint a fresh
 * provider session id that no extension API exposes, so those sessions route
 * natively. Interactive sessions and `--mode rpc` (how Paseo spawns omp) use
 * the session manager's id and are routed.
 *
 * Strategies:
 *   - primary-fallback: route the first eligible account in `order`. The session
 *     locks to that account for prompt cache continuity. On a rate-limit/auth
 *     retry (`auto_retry_start`) or an auto-disabled credential (`credential_disabled`),
 *     advance to the next eligible account in `order` (wrapping if needed) and
 *     remain locked to it for subsequent prompts.
 *   - weekly-deadline-first: rank accounts by weekly drain rate (quota expiring
 *     soonest), with 5-hour window breaking ties and hard floors (<3%) sorting
 *     exhausted accounts last. The winning account is locked for the entire session.
 *     On a rate-limit/auth retry, advance to the best healthy alternative.
 *   - round-robin: rotate the routed account across sessions (default) or
 *     across prompts (`rotate: prompt`). The rotation cursor is persisted per
 *     working directory in ~/.omp/agent/account-routing-state.json so balance
 *     survives process restarts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AuthStorage, ExtensionAPI, ExtensionContext, OAuthAccountSummary } from "@oh-my-pi/pi-coding-agent";

let getAgentDirFn: () => string = () =>
	process.env.OMP_HOME || path.join(process.env.HOME || "", ".omp", "agent");
try {
	// omp provides @oh-my-pi/pi-coding-agent at runtime when running under omp
	const pi = require("@oh-my-pi/pi-coding-agent");
	if (typeof pi.getAgentDir === "function") {
		getAgentDirFn = pi.getAgentDir;
	}
} catch {
	// Standalone test environment fallback
}

export function getAgentDir(): string {
	return getAgentDirFn();
}
/** Minimal ambient for the Bun global (extensions load under Bun; no @types/bun dep). */
declare const Bun: { YAML: { parse(input: string): unknown } };

// ─────────────────────────────────────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderRouting {
	/** Account-selection policy. */
	strategy?:
		| "primary-fallback"
		| "weekly-expiry-first"
		| "weekly-deadline-first"
		| "round-robin"
		| "off";
	/** Preference order: alias names from `accounts`, or raw identity keys. */
	order?: string[];
	/** Subset of `order` usable in this scope. Empty array = no accounts. */
	enabled?: string[];
	/** Round-robin granularity: "session" (default) | "prompt". */
	rotate?: "session" | "prompt";
}

interface AccountRoutingConfig {
	/** alias -> identity key (e.g. "account:google-oauth2|user_..."). */
	accounts?: Record<string, string>;
	/** provider id -> routing. */
	routing?: Record<string, ProviderRouting>;
}

interface ResolvedAccount {
	credentialId: number;
	label: string;
}

type ApplyMode = "initial" | "prompt" | "advance";

// ─────────────────────────────────────────────────────────────────────────────
// State (module-level: survives across sessions in one process)
// ─────────────────────────────────────────────────────────────────────────────

/** `${provider}:${sessionId}` -> credentialId we pinned last. */
const pinned = new Map<string, number>();
/** `${provider}:session:${cwd}` (or `prompt:`) -> next rotation index. */
let counters: Map<string, number> | undefined;
/** Grok Build weekly reset per credential; the billing period is stable between resets. */
const weeklyResetCache = new Map<number, { checkedAt: number; resetsAt: number }>();

const GROK_BUILD_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const WEEKLY_RESET_CACHE_MS = 5 * 60 * 1000;

/**
 * Antigravity quota. `fetchAvailableModels` (what omp's own usage fetcher reads)
 * exposes only the 5-hour counter, so omp's ranking strategy for this provider
 * fills `primary` and leaves `secondary` empty — its comparator checks the
 * weekly window first, then has no weekly number to compare. This endpoint is
 * the one behind AGY's Models & Quota screen and returns both buckets, grouped:
 * `gemini-*` bucket ids for Gemini models, `3p-*` for Claude/GPT.
 */
const ANTIGRAVITY_QUOTA_SUMMARY_URLS = [
	"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;
/** The endpoint answers 403 when the request carries no User-Agent. */
const ANTIGRAVITY_USER_AGENT = "antigravity-cli/1.0";
/**
 * Matches `WEEKLY_RESET_CACHE_MS` and omp core's own ~5 min usage cache. The
 * cache is per process and omp spawns hundreds of them a day, so total request
 * volume scales with process count, not with one host-wide timer. Nothing here
 * needs sub-5-minute freshness: the weekly bucket moves over days, and a 5-hour
 * bucket that empties mid-flight is caught by omp's 429 block, which is shared
 * across processes through sqlite and therefore faster than any poll.
 */
/**
 * Antigravity quota background refresh cadence: 15 minutes.
 * Quotas are read from disk cache immediately with zero blocking latency;
 * if stale or missing, a background fetch updates the disk cache asynchronously.
 */
const ANTIGRAVITY_QUOTA_CACHE_MS = 15 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this the 5-hour bucket will 429 on the next request; skip the round trip. */
export const FIVE_HOUR_FLOOR = 0.03;
/** Below this the weekly bucket will 429 on the next request; skip the round trip. */
export const WEEKLY_FLOOR = 0.03;
/** Weekly rates within this relative spread count as equal, so 5h breaks the tie. */
export const WEEKLY_TIE_RELATIVE = 0.05;

export interface QuotaBucket {
	remainingFraction: number;
	resetsAt?: number;
}

export interface QuotaWindows {
	weekly?: QuotaBucket;
	fiveHour?: QuotaBucket;
}
/** `${credentialId}:${bucketPrefix}` -> last quota read. */
const antigravityQuotaCache = new Map<string, { checkedAt: number; windows: QuotaWindows }>();

function loadAntigravityQuotaCache(): void {
	try {
		const filePath = path.join(getAgentDir(), "antigravity-quota-cache.json");
		if (!existsSync(filePath)) return;
		const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<
			string,
			{ checkedAt: number; windows: QuotaWindows }
		>;
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value?.checkedAt === "number" && value?.windows) {
				antigravityQuotaCache.set(key, value);
			}
		}
	} catch {
		// Corrupted cache is not fatal
	}
}

function saveAntigravityQuotaCache(): void {
	try {
		const filePath = path.join(getAgentDir(), "antigravity-quota-cache.json");
		mkdirSync(path.dirname(filePath), { recursive: true });
		const tmpPath = `${filePath}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(antigravityQuotaCache), null, 2));
		renameSync(tmpPath, filePath);
	} catch {
		// Best-effort
	}
}

loadAntigravityQuotaCache();
export const RATE_LIMIT_ERROR_RE =
	/429|rate\s*[- ]?limit|quota|too many|401|403|unauthorized|authentication|invalid_grant|resource_exhausted|exhausted/i;

// ─────────────────────────────────────────────────────────────────────────────
// Config loading (YAML via Bun.YAML, or JSON)
// ─────────────────────────────────────────────────────────────────────────────

function loadConfigFile(filePath: string): AccountRoutingConfig | undefined {
	try {
		if (!existsSync(filePath)) return undefined;
		const raw = readFileSync(filePath, "utf8");
		const parsed = path.extname(filePath) === ".json" ? JSON.parse(raw) : Bun.YAML.parse(raw);
		return (parsed ?? {}) as AccountRoutingConfig;
	} catch {
		return undefined;
	}
}

function mergeConfig(host?: AccountRoutingConfig, project?: AccountRoutingConfig): AccountRoutingConfig {
	const merged: AccountRoutingConfig = { accounts: {}, routing: {} };
	if (host?.accounts) Object.assign(merged.accounts!, host.accounts);
	if (project?.accounts) Object.assign(merged.accounts!, project.accounts);
	if (host?.routing) {
		for (const [provider, routing] of Object.entries(host.routing)) {
			merged.routing![provider] = { ...routing };
		}
	}
	if (project?.routing) {
		for (const [provider, routing] of Object.entries(project.routing)) {
			merged.routing![provider] = { ...(merged.routing![provider] ?? {}), ...routing };
		}
	}
	return merged;
}

function loadRoutingConfig(cwd: string): AccountRoutingConfig {
	const agentDir = getAgentDir();
	const host =
		loadConfigFile(path.join(agentDir, "account-routing.yml")) ??
		loadConfigFile(path.join(agentDir, "account-routing.json"));
	const project =
		loadConfigFile(path.join(cwd, ".omp", "account-routing.yml")) ??
		loadConfigFile(path.join(cwd, ".omp", "account-routing.json"));
	return mergeConfig(host, project);
}

// ─────────────────────────────────────────────────────────────────────────────
// Account resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveOrder(
	routing: ProviderRouting,
	accounts: Record<string, string> | undefined,
	stored: OAuthAccountSummary[],
): ResolvedAccount[] {
	const order =
		routing.order && routing.order.length > 0
			? routing.order
			: stored.map(account => account.accountId ?? String(account.credentialId));
	const enabled = routing.enabled;
	const resolved: ResolvedAccount[] = [];
	for (const entry of order) {
		if (enabled && !enabled.includes(entry)) continue;
		const identityKey = accounts?.[entry] ?? entry; // alias, or a raw identity key / email
		const match = stored.find(account => {
			const key = identityKey.trim().toLowerCase();
			// Cursor (and other google-oauth logins) store no accountId — only
			// email — so email aliases are the reliable form there.
			if (key.includes("@")) {
				return account.email?.trim().toLowerCase() === key;
			}
			// Identity-key style: stored accountId may be "google-oauth2|user_x"
			// while the config key is the full "account:google-oauth2|user_x".
			if (!account.accountId) return false;
			const accountId = account.accountId.trim();
			return (
				accountId === key ||
				accountId === key.replace(/^account:/, "") ||
				`account:${accountId}` === key
			);
		});
		if (!match) continue;
		resolved.push({ credentialId: match.credentialId, label: entry });
	}
	return resolved;
}
function weeklyResetFromBilling(payload: unknown): number | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const root = payload as Record<string, unknown>;
	const config =
		typeof root.config === "object" && root.config !== null
			? (root.config as Record<string, unknown>)
			: root;
	const currentPeriod =
		typeof config.currentPeriod === "object" && config.currentPeriod !== null
			? (config.currentPeriod as Record<string, unknown>)
			: undefined;
	const rawEnd =
		typeof config.billingPeriodEnd === "string"
			? config.billingPeriodEnd
			: typeof currentPeriod?.end === "string"
				? currentPeriod.end
				: undefined;
	if (!rawEnd) return undefined;
	const resetsAt = Date.parse(rawEnd);
	return Number.isFinite(resetsAt) ? resetsAt : undefined;
}

async function orderByWeeklyExpiry(
	auth: AuthStorage,
	provider: string,
	resolved: ResolvedAccount[],
): Promise<ResolvedAccount[]> {
	if (provider !== "grok-build" || resolved.length < 2) return resolved;

	const now = Date.now();
	const resets = new Map<number, number>();
	for (const account of resolved) {
		const cached = weeklyResetCache.get(account.credentialId);
		if (cached && cached.checkedAt + WEEKLY_RESET_CACHE_MS > now && cached.resetsAt > now) {
			resets.set(account.credentialId, cached.resetsAt);
			continue;
		}

		try {
			const access = await auth.getOAuthAccessByCredentialId(provider, account.credentialId);
			if (!access?.ok) return resolved;
			const response = await fetch(GROK_BUILD_BILLING_URL, {
				headers: {
					Authorization: `Bearer ${access.accessToken}`,
					Accept: "application/json",
					"X-XAI-Token-Auth": "xai-grok-cli",
				},
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) return resolved;
			const resetsAt = weeklyResetFromBilling(await response.json());
			if (resetsAt === undefined) return resolved;
			weeklyResetCache.set(account.credentialId, { checkedAt: now, resetsAt });
			resets.set(account.credentialId, resetsAt);
		} catch {
			return resolved;
		}
	}

	return [...resolved].sort((left, right) => {
		const leftReset = resets.get(left.credentialId);
		const rightReset = resets.get(right.credentialId);
		if (leftReset === undefined || rightReset === undefined) return 0;
		const byReset = leftReset - rightReset;
		return byReset || resolved.indexOf(left) - resolved.indexOf(right);
	});
}

/**
 * Model id may arrive provider-qualified ("google-antigravity/gemini-3.7-flash"),
 * so match on the trailing segment the way omp's own family lookup does.
 */
export function antigravityBucketPrefix(modelId: string | undefined): string {
	const raw = modelId ?? "";
	const slash = raw.lastIndexOf("/");
	const model = (slash === -1 ? raw : raw.slice(slash + 1)).trim().toLowerCase();
	if (model.startsWith("claude-") || model.startsWith("gpt-") || model.startsWith("openai/")) {
		return "3p-";
	}
	// Gemini is the default: an unknown id is far more likely a Gemini variant
	// than a third-party one, and every Antigravity modelRole here is gemini-*.
	return "gemini-";
}

export function parseQuotaSummary(payload: unknown, bucketPrefix: string): QuotaWindows {
	const windows: QuotaWindows = {};
	if (typeof payload !== "object" || payload === null) return windows;
	const groups = (payload as { groups?: unknown }).groups;
	if (!Array.isArray(groups)) return windows;
	for (const group of groups) {
		if (typeof group !== "object" || group === null) continue;
		const buckets = (group as { buckets?: unknown }).buckets;
		if (!Array.isArray(buckets)) continue;
		for (const bucket of buckets) {
			if (typeof bucket !== "object" || bucket === null) continue;
			const fields = bucket as Record<string, unknown>;
			const bucketId = typeof fields.bucketId === "string" ? fields.bucketId : "";
			if (!bucketId.startsWith(bucketPrefix)) continue;
			if (typeof fields.remainingFraction !== "number") continue;
			const resetsAt = typeof fields.resetTime === "string" ? Date.parse(fields.resetTime) : Number.NaN;
			const parsed: QuotaBucket = {
				remainingFraction: fields.remainingFraction,
				...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
			};
			if (fields.window === "weekly" || bucketId.endsWith("-weekly") || bucketId.includes("weekly")) {
				windows.weekly = parsed;
			} else if (fields.window === "5h" || bucketId.endsWith("-5h") || bucketId.includes("5h")) {
				windows.fiveHour = parsed;
			}
		}
	}
	return windows;
}

/** Fraction of the bucket that must be spent per hour to avoid losing it at reset. */
export function drainRate(bucket: QuotaBucket | undefined, now: number, fallbackMs: number): number {
	if (!bucket) return 0;
	const resetsAt = bucket.resetsAt ?? now + fallbackMs;
	const hours = Math.max((resetsAt - now) / 3_600_000, 1 / 60);
	return bucket.remainingFraction / hours;
}

/** In-flight fetch deduplication to avoid redundant concurrent requests. */
const inFlightQuotaFetches = new Set<string>();

async function fetchAntigravityWindows(
	auth: AuthStorage,
	provider: string,
	credentialId: number,
	bucketPrefix: string,
): Promise<QuotaWindows | undefined> {
	const cacheKey = `${credentialId}:${bucketPrefix}`;
	if (inFlightQuotaFetches.has(cacheKey)) return undefined;
	inFlightQuotaFetches.add(cacheKey);

	try {
		// omp owns the credential and the refresh lease; only borrow the access token.
		const access = await auth.getOAuthAccessByCredentialId(provider, credentialId);
		if (!access?.ok || !access.projectId) return undefined;

		const fetchStartTime = Date.now();
		for (const url of ANTIGRAVITY_QUOTA_SUMMARY_URLS) {
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${access.accessToken}`,
						"Content-Type": "application/json",
						"User-Agent": ANTIGRAVITY_USER_AGENT,
					},
					body: JSON.stringify({ project: access.projectId }),
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) continue;
				const windows = parseQuotaSummary(await response.json(), bucketPrefix);
				if (!windows.weekly && !windows.fiveHour) continue;

				// If a newer event (like 429 rate-limit exhaustion) updated this entry
				// while our fetch was in flight, do not overwrite it with stale API data.
				const existing = antigravityQuotaCache.get(cacheKey);
				if (existing && existing.checkedAt >= fetchStartTime) {
					return existing.windows;
				}

				antigravityQuotaCache.set(cacheKey, { checkedAt: Date.now(), windows });
				saveAntigravityQuotaCache();
				return windows;
			} catch {
				// Fall through to the next endpoint.
			}
		}
	} finally {
		inFlightQuotaFetches.delete(cacheKey);
	}
	return undefined;
}

function triggerBackgroundRefresh(
	auth: AuthStorage,
	pi: ExtensionAPI,
	provider: string,
	accountsToRefresh: ResolvedAccount[],
	modelId: string | undefined,
): void {
	const bucketPrefix = antigravityBucketPrefix(modelId);
	Promise.allSettled(
		accountsToRefresh.map(account => fetchAntigravityWindows(auth, provider, account.credentialId, bucketPrefix)),
	)
		.then(() => {
			pi.logger.info(`account-routing: background quota refresh completed (${bucketPrefix})`);
		})
		.catch(() => {});
}

/**
 * Rank by weekly drain rate, descending: the account whose weekly allowance is
 * closest to expiring goes first, because that is the quota you actually lose.
 * The 5-hour window only breaks ties — when a weekly is under deadline pressure
 * the account still gets several fresh 5-hour buckets before the weekly resets,
 * and an emptied 5-hour bucket costs one 429 that omp records as a shared,
 * counter-scoped block, so every later session skips the account for free.
 *
 * Non-blocking by default in production: uses cached data immediately (0ms)
 * and triggers background refresh if stale or missing.
 */
export async function orderByWeeklyDeadline(
	auth: AuthStorage,
	pi: ExtensionAPI,
	provider: string,
	resolved: ResolvedAccount[],
	modelId: string | undefined,
	options?: { allowInlineFetch?: boolean },
): Promise<ResolvedAccount[]> {
	if (resolved.length < 2) return resolved;

	const allowInlineFetch = options?.allowInlineFetch ?? true;
	const bucketPrefix = antigravityBucketPrefix(modelId);
	const now = Date.now();
	const scored: {
		account: ResolvedAccount;
		weeklyRate: number;
		fiveHourRate: number;
		exhausted: boolean;
		hasQuotaData: boolean;
	}[] = [];

	const accountsToRefresh: ResolvedAccount[] = [];

	for (const account of resolved) {
		const cacheKey = `${account.credentialId}:${bucketPrefix}`;
		let cached = antigravityQuotaCache.get(cacheKey);

		// If cache is stale (> 15 min) or missing:
		if (!cached || now - cached.checkedAt > ANTIGRAVITY_QUOTA_CACHE_MS) {
			if (allowInlineFetch && !cached) {
				const fresh = await fetchAntigravityWindows(auth, provider, account.credentialId, bucketPrefix);
				if (fresh) {
					cached = { checkedAt: now, windows: fresh };
				}
			} else {
				accountsToRefresh.push(account);
			}
		}

		const windows = cached?.windows;
		if (!windows) {
			scored.push({
				account,
				weeklyRate: 0,
				fiveHourRate: 0,
				exhausted: false,
				hasQuotaData: false,
			});
			continue;
		}

		const isFiveHourExhausted =
			windows.fiveHour !== undefined && windows.fiveHour.remainingFraction < FIVE_HOUR_FLOOR;
		const isWeeklyExhausted =
			windows.weekly !== undefined && windows.weekly.remainingFraction < WEEKLY_FLOOR;

		scored.push({
			account,
			weeklyRate: drainRate(windows.weekly, now, WEEK_MS),
			fiveHourRate: drainRate(windows.fiveHour, now, FIVE_HOUR_MS),
			exhausted: isFiveHourExhausted || isWeeklyExhausted,
			hasQuotaData: true,
		});
	}

	if (accountsToRefresh.length > 0) {
		triggerBackgroundRefresh(auth, pi, provider, accountsToRefresh, modelId);
	}

	scored.sort((left, right) => {
		// Non-exhausted accounts always come before exhausted accounts
		if (left.exhausted !== right.exhausted) return left.exhausted ? 1 : -1;

		// When both are non-exhausted (or both exhausted):
		// If both have quota data, rank by weekly drain rate then 5h drain rate
		if (left.hasQuotaData && right.hasQuotaData) {
			const spread = Math.max(left.weeklyRate, right.weeklyRate);
			const tied = spread <= 0 || Math.abs(left.weeklyRate - right.weeklyRate) / spread <= WEEKLY_TIE_RELATIVE;
			if (!tied) return right.weeklyRate - left.weeklyRate;
			if (left.fiveHourRate !== right.fiveHourRate) return right.fiveHourRate - left.fiveHourRate;
		} else if (left.hasQuotaData !== right.hasQuotaData) {
			// Account with verified quota data is preferred over unknown
			return left.hasQuotaData ? -1 : 1;
		}

		return resolved.indexOf(left.account) - resolved.indexOf(right.account);
	});

	pi.logger.info(
		`account-routing: ${provider} weekly-deadline ranking (${bucketPrefix}) ${scored
			.map(
				entry =>
					`${entry.account.label}#${entry.account.credentialId} weekly=${(entry.weeklyRate * 100).toFixed(2)}%/h 5h=${(entry.fiveHourRate * 100).toFixed(2)}%/h${entry.exhausted ? " [exhausted]" : ""}${!entry.hasQuotaData ? " [no quota data]" : ""}`,
			)
			.join(" | ")}`,
	);

	return scored.map(entry => entry.account);
}


// ─────────────────────────────────────────────────────────────────────────────
// Rotation cursor (persisted per working directory)
// ─────────────────────────────────────────────────────────────────────────────

function stateFilePath(): string {
	return path.join(getAgentDir(), "account-routing-state.json");
}

function getCounters(): Map<string, number> {
	if (counters) return counters;
	counters = new Map();
	try {
		const filePath = stateFilePath();
		if (existsSync(filePath)) {
			const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, number>;
			for (const [key, value] of Object.entries(raw)) {
				if (typeof value === "number" && Number.isFinite(value)) counters.set(key, value);
			}
		}
	} catch {
		// Corrupted state is not fatal; rotation restarts from zero.
	}
	return counters;
}

function saveCounters(): void {
	try {
		const filePath = stateFilePath();
		mkdirSync(path.dirname(filePath), { recursive: true });
		const tmpPath = `${filePath}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(getCounters())));
		renameSync(tmpPath, filePath);
	} catch {
		// Best-effort; rotation still works for this process.
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement
// ─────────────────────────────────────────────────────────────────────────────

function pinAccount(
	auth: AuthStorage,
	pi: ExtensionAPI,
	provider: string,
	sessionId: string,
	target: ResolvedAccount,
): void {
	// Session-sticky pin. `sessionId` must be the session manager's id: that is
	// what `AgentSession.sessionId` (#activeProviderSessionId) resolves to for a
	// normally-booted session, which is the id request-time key resolution uses.
	const ok = auth.pinSessionOAuthAccount(provider, sessionId, target.credentialId);
	if (!ok) {
		// pinSessionOAuthAccount refuses while an explicit --api-key / config
		// apiKey override owns the provider. That override is deliberate, so
		// leave it alone.
		pi.logger.warn(
			`account-routing: pin refused for ${provider} (${target.label}); an explicit api-key override is active`,
		);
		return;
	}
	pinned.set(`${provider}:${sessionId}`, target.credentialId);
	const identity = auth.getOAuthAccountIdentity(provider, sessionId);
	const who = identity?.email ?? identity?.accountId ?? "";
	pi.logger.info(
		`account-routing: pinned ${provider} -> ${target.label} (#${target.credentialId}${who ? `, ${who}` : ""})`,
	);
}

async function applyRouting(ctx: ExtensionContext, pi: ExtensionAPI, mode: ApplyMode): Promise<void> {
	try {
		const config = loadRoutingConfig(ctx.cwd);
		if (!config.routing) return;
		const auth = ctx.modelRegistry.authStorage;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		// `ExtensionContext.model` is populated at session_start and
		// before_agent_start. Narrow rather than assert: a published context type
		// without `model` must not turn this read into an unchecked cast.
		let modelId: string | undefined;
		if ("model" in ctx && typeof ctx.model === "object" && ctx.model !== null && "id" in ctx.model) {
			modelId = typeof ctx.model.id === "string" ? ctx.model.id : undefined;
		}

		for (const [provider, routing] of Object.entries(config.routing)) {
			if (!routing || routing.strategy === "off") continue;
			const stored = auth.listOAuthAccounts(provider);
			if (!stored || stored.length === 0) continue;
			let resolved = resolveOrder(routing, config.accounts, stored);
			if (resolved.length === 0) continue;

			const current = pinned.get(`${provider}:${sessionId}`);

			// Session stickiness: once an agent session is pinned to an account,
			// keep using that account on every prompt of the session to maintain
			// prompt cache continuity. Do not re-rank or change accounts mid-session.
			// Only switch on hard errors (mode === "advance").
			// Exception: round-robin with rotate: prompt rotates on every prompt by design.
			if (
				mode === "prompt" &&
				current !== undefined &&
				!(routing.strategy === "round-robin" && routing.rotate === "prompt")
			) {
				const existing = resolved.find(account => account.credentialId === current);
				if (existing) {
					auth.pinSessionOAuthAccount(provider, sessionId, existing.credentialId);
					continue;
				}
			}

			if (routing.strategy === "weekly-expiry-first") {
				resolved = await orderByWeeklyExpiry(auth, provider, resolved);
			} else if (routing.strategy === "weekly-deadline-first") {
				resolved = await orderByWeeklyDeadline(auth, pi, provider, resolved, modelId, {
					allowInlineFetch: false,
				});
			}

			if (routing.strategy === "round-robin") {
				const rotateKey = `${provider}:${routing.rotate === "prompt" ? "prompt:" : "session:"}${ctx.cwd}`;
				const ownsRotation = routing.rotate === "prompt" ? mode === "prompt" : mode === "initial";
				let index: number;
				if (ownsRotation || mode === "advance") {
					const counter = getCounters().get(rotateKey) ?? 0;
					index = counter % resolved.length;
					getCounters().set(rotateKey, counter + 1);
					saveCounters();
				} else {
					index = resolved.findIndex(account => account.credentialId === current);
					if (index === -1) index = 0;
				}
				pinAccount(auth, pi, provider, sessionId, resolved[index % resolved.length]);
			} else if (routing.strategy === "weekly-deadline-first" || routing.strategy === "weekly-expiry-first") {
				let target = resolved[0];
				if (mode === "advance") {
					// Advance to the best ranked account that is not the failing one.
					// Since failed accounts were poisoned in cache prior to advance,
					// orderByWeeklyDeadline places healthy accounts first.
					target = resolved.find(account => account.credentialId !== current) ?? resolved[0];
				}
				pinAccount(auth, pi, provider, sessionId, target);
			} else {
				// primary-fallback (or default preference order): advance sequentially through order
				let target = resolved[0];
				if (mode === "advance") {
					const currentIndex = resolved.findIndex(account => account.credentialId === current);
					const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % resolved.length : 0;
					target = resolved[nextIndex];
				}
				pinAccount(auth, pi, provider, sessionId, target);
			}
		}
	} catch (error) {
		pi.logger.warn(`account-routing: apply failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry
// ─────────────────────────────────────────────────────────────────────────────

export default function ompAccountRoutingExtension(pi: ExtensionAPI): void {
	pi.setLabel("Account Routing");
	pi.logger.info("account-routing: extension loaded");

	loadAntigravityQuotaCache();

	let lastAuthStorage: AuthStorage | undefined;

	// Background job: proactively refreshes Antigravity quota every 15 minutes
	const backgroundTimer = setInterval(() => {
		if (!lastAuthStorage) return;
		try {
			const config = loadRoutingConfig(getAgentDir());
			const routing = config.routing?.["google-antigravity"];
			if (!routing || routing.strategy === "off") return;
			const stored = lastAuthStorage.listOAuthAccounts("google-antigravity");
			if (!stored || stored.length === 0) return;
			const resolved = resolveOrder(routing, config.accounts, stored);
			if (resolved.length === 0) return;
			triggerBackgroundRefresh(lastAuthStorage, pi, "google-antigravity", resolved, undefined);
		} catch {
			// Non-fatal background timer error
		}
	}, ANTIGRAVITY_QUOTA_CACHE_MS);
	backgroundTimer.unref?.();

	const captureAuth = (ctx: ExtensionContext) => {
		if (ctx.modelRegistry?.authStorage) {
			lastAuthStorage = ctx.modelRegistry.authStorage;
		}
	};

	// Fresh or resumed session: apply the config-driven routing. For
	// round-robin with rotate:session this is the rotation point.
	pi.on("session_start", (_event, ctx) => {
		captureAuth(ctx);
		return applyRouting(ctx, pi, "initial");
	});
	pi.on("session_switch", (_event, ctx) => {
		captureAuth(ctx);
		return applyRouting(ctx, pi, "initial");
	});

	// Fires after prompt submission, right before the agent loop — the last
	// word before the first request resolves its API key. Handlers are awaited
	// here, so the runtime override is armed before any request goes out.
	pi.on("before_agent_start", (_event, ctx) => {
		captureAuth(ctx);
		return applyRouting(ctx, pi, "prompt");
	});
	// A rate-limit/auth retry: advance primary-fallback so the retry runs on
	// the next eligible account. omp's native blocked-credential skip would
	// also route around it; this enforces the *preferred* order explicitly.
	pi.on("auto_retry_start", (event, ctx) => {
		if (!RATE_LIMIT_ERROR_RE.test(event.errorMessage)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) {
			for (const [key, credentialId] of pinned.entries()) {
				if (key.endsWith(`:${sessionId}`)) {
					// Mark cached quota as exhausted for this credential so even if the quota
					// summary endpoint has a reporting lag, subsequent rankings treat this
					// account as exhausted and keep using the alternate account.
					for (const bucketPrefix of ["gemini-", "3p-"]) {
						antigravityQuotaCache.set(`${credentialId}:${bucketPrefix}`, {
							checkedAt: Date.now(),
							windows: {
								fiveHour: { remainingFraction: 0 },
								weekly: { remainingFraction: 0 },
							},
						});
					}
				}
			}
			saveAntigravityQuotaCache();
		}
		return applyRouting(ctx, pi, "advance");
	});

	// omp auto-disabled a credential (invalid_grant etc.): move to the next
	// eligible account rather than waiting for the next prompt.
	pi.on("credential_disabled", (_event, ctx) => applyRouting(ctx, pi, "advance"));

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		for (const key of [...pinned.keys()]) {
			if (key.endsWith(`:${sessionId}`)) pinned.delete(key);
		}
	});
}
export {
	type ProviderRouting,
	type AccountRoutingConfig,
	type ResolvedAccount,
	loadConfigFile,
	mergeConfig,
	loadRoutingConfig,
	resolveOrder,
	applyRouting,
	antigravityQuotaCache,
	loadAntigravityQuotaCache,
	saveAntigravityQuotaCache,
	triggerBackgroundRefresh,
	fetchAntigravityWindows,
	ANTIGRAVITY_QUOTA_CACHE_MS,
	pinned,
};
