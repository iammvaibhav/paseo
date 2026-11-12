// Account listing and pinning. Explicit account pins one stored credential;
// `auto` reuses the account-routing plugin logic when it configures the
// provider, else pi-ai built-in selection; `any` skips pinning.
import type { AuthStorage, OAuthAccountSummary } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { orderByWeeklyDeadline } from "../vendor/omp-account-routing/index";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROUTING_PATH = path.join(getAgentDir(), "account-routing.yml");

interface ProviderRouting {
	strategy?: "primary-fallback" | "weekly-expiry-first" | "weekly-deadline-first" | "round-robin" | "off";
	order?: string[];
	enabled?: string[];
	rotate?: "session" | "prompt";
}

interface RoutingConfig {
	accounts?: Record<string, string>;
	routing?: Record<string, ProviderRouting>;
}

export function readRoutingConfig(): RoutingConfig {
	try {
		if (!existsSync(ROUTING_PATH)) return {};
		const parsed = Bun.YAML.parse(readFileSync(ROUTING_PATH, "utf8")) as RoutingConfig | undefined;
		return parsed ?? {};
	} catch {
		return {};
	}
}

export function aliasFor(credential: { credentialId: number; email?: string; accountId?: string }): string | null {
	const accounts = readRoutingConfig().accounts ?? {};
	for (const [alias, key] of Object.entries(accounts)) {
		if (typeof key !== "string") continue;
		const want = key.trim().toLowerCase();
		if (want.includes("@")) {
			if (credential.email?.trim().toLowerCase() === want) return alias;
		} else if (credential.accountId && credential.accountId.trim().length > 0) {
			const have = credential.accountId.trim();
			if (have === key || have === key.replace(/^account:/, "") || `account:${have}` === key) return alias;
		}
	}
	return null;
}

// Match one stored account by alias, email, or credential row id.
export function matchAccount(
	stored: OAuthAccountSummary[],
	spec: string,
): OAuthAccountSummary | undefined {
	const key = spec.trim().toLowerCase();
	for (const account of stored) {
		const alias = aliasFor(account);
		if (alias !== null && alias.toLowerCase() === key) return account;
	}
	if (key.includes("@")) {
		return stored.find(account => account.email?.trim().toLowerCase() === key);
	}
	const numeric = Number(spec);
	if (Number.isInteger(numeric)) {
		return stored.find(account => account.credentialId === numeric);
	}
	for (const account of stored) {
		if (!account.accountId) continue;
		const have = account.accountId.trim();
		if (have === spec || have === spec.replace(/^account:/, "") || `account:${have}` === spec) return account;
	}
	return undefined;
}

export function resolveOrderFor(
	routing: ProviderRouting,
	accounts: Record<string, string> | undefined,
	stored: OAuthAccountSummary[],
): Array<{ credentialId: number; label: string }> {
	const order =
		routing.order && routing.order.length > 0
			? routing.order
			: stored.map(account => account.accountId ?? String(account.credentialId));
	const enabled = routing.enabled;
	const out: Array<{ credentialId: number; label: string }> = [];
	for (const entry of order) {
		if (enabled && !enabled.includes(entry)) continue;
		const found = matchAccount(stored, accounts?.[entry] ?? entry);
		if (found) out.push({ credentialId: found.credentialId, label: entry });
	}
	return out;
}

export type AccountSpec =
	| { kind: "auto" }
	| { kind: "any" }
	| { kind: "explicit"; value: string }
	| { kind: "invalid"; value: string };
export function parseAccountSpec(raw: string | null): AccountSpec {
	const value = (raw ?? "auto").trim();
	if (value === "" || value === "auto") return { kind: "auto" };
	if (value === "any") return { kind: "any" };
	if (value.includes("/") || value.includes("\0")) return { kind: "invalid", value };
	return { kind: "explicit", value };
}

// Pin the session to the chosen credential. `auto` with plugin routing for
// this provider ranks via the account-routing plugin, else pi-ai built-in
// selection (no pin). Returns the pinned credential id, if any.
export async function pinForRequest(
	storage: AuthStorage,
	provider: string,
	sessionId: string,
	spec: AccountSpec,
	pi: { logger: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void } },
	modelId?: string,
	modelAccountIds?: readonly string[],
): Promise<number | undefined> {
	if (spec.kind === "any") return undefined;
	const stored = storage.oauth.accounts(provider);
	if (spec.kind === "explicit") {
		// api-key rows (opencode-go) have no oauth account; match by row id only.
		const numeric = Number(spec.value);
		if (Number.isInteger(numeric)) {
			const rows = storage.credentials.list(provider);
			const row = rows.find(entry => entry.id === numeric);
			if (!row) throw new Error(`Unknown account: ${spec.value}`);
			if (row.credential.type === "oauth") storage.sessions.pin(provider, sessionId, numeric);
			else storage.sessions.release(provider, sessionId);
			return numeric;
		}
		const found = matchAccount(stored, spec.value);
		if (!found) throw new Error(`Unknown account: ${spec.value}`);
		storage.sessions.pin(provider, sessionId, found.credentialId);
		return found.credentialId;
	}
	const config = readRoutingConfig();
	const routing = config.routing?.[provider];
	if (!routing || routing.strategy === "off") return undefined;
	if (stored.length === 0) return undefined;
	let candidates = resolveOrderFor(routing, config.accounts, stored);
	if (candidates.length === 0) return undefined;
	// Skip accounts that model discovery saw without access to this model
	// (Codex `accountAccess`); pi-ai honours a pin even when the account
	// cannot serve the model, which gives `model_not_found`.
	if (modelAccountIds && modelAccountIds.length > 0) {
		const allowed = new Set(modelAccountIds);
		const served = candidates.filter(entry => {
			const accountId = stored.find(account => account.credentialId === entry.credentialId)?.accountId;
			return accountId !== undefined && allowed.has(accountId);
		});
		if (served.length === 0) return undefined;
		candidates = served;
	}
	if (routing.strategy === "weekly-deadline-first") {
		// The plugin reads only `pi.logger` on this path.
		candidates = await orderByWeeklyDeadline(storage, pi as unknown as ExtensionAPI, provider, candidates, modelId, {
			allowInlineFetch: false,
		});
	}
	// Session stickiness: keep the pinned account when still listed.
	const pinnedRows = storage.oauth.accounts(provider, sessionId);
	const active = pinnedRows.find(account => account.active);
	if (active && candidates.some(entry => entry.credentialId === active.credentialId)) {
		storage.sessions.pin(provider, sessionId, active.credentialId);
		return active.credentialId;
	}
	const target = candidates[0];
	storage.sessions.pin(provider, sessionId, target.credentialId);
	return target.credentialId;
}
