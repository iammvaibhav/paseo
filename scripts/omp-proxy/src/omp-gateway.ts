// The one place omp-proxy calls omp's auth-gateway credential helpers.
//
// omp exports every module (`"./*"` in pi-ai's package.json) and has no
// public/internal split, and these helpers are written for omp's own gateway
// server: their signatures change between releases (18.11 replaced the
// AuthStorage argument with an options object and made the account helper
// take the resolved key). Keep every call here so an omp bump touches one
// file, and give the rest of the proxy a shape that does not follow omp.
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolver, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import {
	buildGatewayApiKeyResolver,
	resolveGatewayAccount,
	resolveGatewayApiKey,
} from "@oh-my-pi/pi-ai/auth-gateway/dispatch";

export interface GatewayKey {
	apiKey: string;
	/** The stored credential that supplied the key, when omp knows it. */
	credentialId: number | undefined;
	/** Session-state account key: the same credential maps to the same account. */
	account: string;
}

export interface GatewayKeyError {
	status: number;
	type: string;
	message: string;
}

function toGatewayKey(resolved: ResolvedApiKey): GatewayKey {
	return {
		apiKey: resolved.apiKey,
		credentialId: resolved.credentialId,
		account: resolveGatewayAccount(resolved),
	};
}

export async function resolveKey(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	peer: string,
): Promise<GatewayKey | GatewayKeyError> {
	const resolved = await resolveGatewayApiKey({ storage }, model, sessionId, signal, peer);
	if ("status" in resolved) return resolved;
	return toGatewayKey(resolved);
}

/** The per-attempt key resolver for streamSimple; onKey sees each key omp switches to. */
export function keyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initial: GatewayKey,
	signal: AbortSignal,
	format: string,
	peer: string,
	onKey: (key: GatewayKey) => void,
): ApiKeyResolver {
	return buildGatewayApiKeyResolver(
		{ storage },
		model,
		sessionId,
		{ apiKey: initial.apiKey, credentialId: initial.credentialId },
		signal,
		format,
		peer,
		resolved => onKey(toGatewayKey(resolved)),
	);
}
