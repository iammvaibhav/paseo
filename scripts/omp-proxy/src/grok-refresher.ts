// Keeps grok-build OAuth tokens fresh in the OMP credential store on the
// broker host. `omp auth-broker serve` cannot refresh grok-build, because
// that provider comes from a plugin ("Unknown OAuth provider: grok-build").
// The broker reads changes that other processes write to agent.db and sends
// them to its clients, so a token refreshed here reaches omp-proxy.
//
// Run on the broker host only. It opens the local agent.db directly (never
// the broker), and the store's refresh leases keep it safe next to the
// broker and running omp sessions.
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { refreshGrokBuildOAuthToken } from "../vendor/omp-grok-build/xai-device-oauth";

const PROVIDER = "grok-build";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Well before pi-ai's 5-minute refresh skew, so broker clients never ask the
// broker for a grok-build refresh (which fails).
const REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;

const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
// Same call as the plugin's own `oauth.refreshToken` (omp-grok-build src/index.ts).
const storage = new AuthStorage(store, {
	refreshOAuthCredential: (provider, _credentialId, credential) => {
		if (provider !== PROVIDER) {
			return Promise.reject(new Error(`grok-refresher refreshes only ${PROVIDER}, not ${provider}`));
		}
		return refreshGrokBuildOAuthToken(credential.refresh, undefined, {
			email: credential.email,
			accountId: credential.accountId,
		});
	},
});

function log(message: string, fields: Record<string, unknown> = {}): void {
	process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

async function sweep(): Promise<void> {
	await storage.credentials.reload();
	for (const row of storage.credentials.list(PROVIDER)) {
		if (row.disabledCause !== null || row.credential.type !== "oauth") continue;
		const remainingMs = row.credential.expires - Date.now();
		if (remainingMs > REFRESH_BEFORE_EXPIRY_MS) continue;
		try {
			await storage.oauth.refresh(row.id);
			const next = storage.credentials.list(PROVIDER).find(entry => entry.id === row.id)?.credential;
			const expiresInMin = next?.type === "oauth" ? Math.round((next.expires - Date.now()) / 60_000) : null;
			log("refreshed", { credentialId: row.id, expiresInMin });
		} catch (error) {
			log("refresh failed", { credentialId: row.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

log("grok-refresher started", { checkIntervalMin: CHECK_INTERVAL_MS / 60_000, refreshBeforeMin: REFRESH_BEFORE_EXPIRY_MS / 60_000 });
await sweep();
setInterval(() => void sweep(), CHECK_INTERVAL_MS);
