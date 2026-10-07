// HTTP front: routes per contract, CORS, embedded UI files, request records.
import indexHtml from "../public/index.html" with { type: "file" };
import appCss from "../public/app.css" with { type: "file" };
// @ts-expect-error TS7016: plain browser script, imported only for its file path.
import appJs from "../public/app.js" with { type: "file" };
import { AuthGatewaySessionStateStore } from "@oh-my-pi/pi-ai/auth-gateway/session-state";
import { corsHeaders, withCors } from "@oh-my-pi/pi-ai/auth-gateway/http";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import { aliasFor, readRoutingConfig } from "./accounts";
import { bootProxy, defaultModelFor, PROVIDER_LABELS, PROVIDERS, VERSION } from "./boot";
import type { Boot, ProviderId } from "./boot";
import { handleChat, ROUTES } from "./dispatch";
import { getRecord, listRecords } from "./records";

const OMP_HEADERS = [
	"x-omp-request-id",
	"x-omp-provider",
	"x-omp-model",
	"x-omp-session-id",
	"x-omp-session-source",
	"x-omp-account",
	"x-omp-credential-id",
	"x-omp-proxy-overhead-ms",
];

function corsWithOmp(req: Request): Record<string, string> {
	const base = corsHeaders(req);
	const expose = base["Access-Control-Expose-Headers"] ?? "";
	return { ...base, "Access-Control-Expose-Headers": `${expose}, ${OMP_HEADERS.join(", ")}` };
}

function withProxyCors(response: Response, req: Request): Response {
	const headed = withCors(response, req);
	const headers = new Headers(headed.headers);
	const extra = corsWithOmp(req);
	for (const key of Object.keys(extra)) headers.set(key, extra[key]);
	return new Response(headed.body, { status: headed.status, statusText: headed.statusText, headers });
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function peerOf(req: Request): string {
	const fwd = req.headers.get("x-forwarded-for");
	if (fwd) return fwd.split(",")[0].trim();
	return req.headers.get("x-real-ip") ?? "unknown";
}

function bindTarget(): { hostname: string; port: number } {
	return parseBind(process.env.OMP_PROXY_BIND ?? "127.0.0.1:4317");
}

function isLoopback(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1";
}

function authorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}

// UI files are imported with `type: "file"`, so `bun build --compile` embeds
// them and the import value is a file path. bun-types types `.html` imports
// as HTMLBundle (the default import mode), hence the cast.
const UI_FILES: Record<string, { path: string; type: string }> = {
	"/": { path: indexHtml as unknown as string, type: "text/html; charset=utf-8" },
	"/app.js": { path: appJs, type: "text/javascript; charset=utf-8" },
	"/app.css": { path: appCss, type: "text/css; charset=utf-8" },
};

function providerPayload(boot: Boot, provider: ProviderId) {
	const models = boot.providerModels.get(provider) ?? [];
	const oauthRows = boot.storage.oauth.accounts(provider);
	const routing = readRoutingConfig();
	const accounts = oauthRows.map(row => ({
		credentialId: row.credentialId,
		label: aliasFor(row),
		email: row.email ?? null,
		identityKey: row.accountId ?? null,
		// Tombstone probe is async; rows listed here come from the live pool.
		disabled: false,
	}));
	if (provider === "opencode-go") {
		for (const entry of boot.storage.credentials.list(provider)) {
			if (entry.credential.type !== "api_key") continue;
			if (accounts.some(account => account.credentialId === entry.id)) continue;
			accounts.push({ credentialId: entry.id, label: null, email: null, identityKey: null, disabled: false });
		}
		accounts.sort((left, right) => left.credentialId - right.credentialId);
	}
	const route = routing.routing?.[provider];
	return {
		id: provider,
		label: PROVIDER_LABELS[provider],
		accounts,
		routing: route ? { strategy: route.strategy ?? "off", order: route.order ?? [] } : null,
		defaultModel: defaultModelFor(provider, models),
		modelCount: models.length,
	};
}

function modelRow(provider: ProviderId, model: { id: string; name: string; api: string; contextWindow: number | null; maxTokens: number | null; reasoning: boolean; thinking?: { efforts?: readonly string[] }; input: readonly string[] }) {
	return {
		id: `${provider}/${model.id}`,
		object: "model",
		owned_by: provider,
		display_name: model.name,
		api: model.api,
		context_length: model.contextWindow,
		max_output_tokens: model.maxTokens,
		reasoning: model.reasoning,
		thinking_levels: [...(model.thinking?.efforts ?? [])],
		input_modalities: [...model.input],
	};
}

async function serve(): Promise<void> {
	const bind = bindTarget();
	// OMP_PROXY_NO_AUTH=1 allows a non-loopback bind with no token (for a private network only).
	const noAuth = process.env.OMP_PROXY_NO_AUTH === "1";
	if (!isLoopback(bind.hostname) && !process.env.OMP_PROXY_TOKEN && !noAuth) {
		throw new Error("Non-loopback bind needs OMP_PROXY_TOKEN set, or OMP_PROXY_NO_AUTH=1.");
	}
	const tokens = new Set<string>(process.env.OMP_PROXY_TOKEN ? [process.env.OMP_PROXY_TOKEN] : []);
	const boot = await bootProxy();
	const sessionStates = new AuthGatewaySessionStateStore();

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		idleTimeout: 255,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = peerOf(req);
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsWithOmp(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withProxyCors(json(200, { ok: true, version: VERSION }), req);
				}
				if ((pathname.startsWith("/v1/") || pathname.startsWith("/api/")) && !authorized(req, tokens)) {
					return withProxyCors(json(401, { error: "unauthorized" }), req);
				}
				if (req.method === "GET" && pathname === "/api/providers") {
					return withProxyCors(
						json(200, { providers: PROVIDERS.map(provider => providerPayload(boot, provider)) }),
						req,
					);
				}
				if (req.method === "GET" && pathname === "/v1/models") {
					const data = PROVIDERS.flatMap(provider =>
						(boot.providerModels.get(provider) ?? []).map(model => modelRow(provider, model)),
					);
					return withProxyCors(json(200, { object: "list", data }), req);
				}
				const providerModels = req.method === "GET" ? /^\/v1\/([^/]+)\/models$/.exec(pathname) : null;
				if (providerModels) {
					const provider = providerModels[1] as ProviderId;
					if (!PROVIDERS.includes(provider)) return withProxyCors(json(404, { error: "unknown provider" }), req);
					const data = (boot.providerModels.get(provider) ?? []).map(model => modelRow(provider, model));
					return withProxyCors(json(200, { object: "list", data }), req);
				}
				if (req.method === "GET" && pathname === "/api/requests") {
					const limit = Number(url.searchParams.get("limit") ?? "100");
					return withProxyCors(json(200, { requests: listRecords(limit) }), req);
				}
				const requestOne = req.method === "GET" ? /^\/api\/requests\/([^/]+)$/.exec(pathname) : null;
				if (requestOne) {
					const record = getRecord(decodeURIComponent(requestOne[1]));
					if (!record) return withProxyCors(json(404, { error: "unknown request" }), req);
					return withProxyCors(json(200, record), req);
				}
				if (req.method === "POST") {
					const direct = ROUTES[pathname];
					if (direct) {
						return withProxyCors(await handleChat(direct, { boot, sessionStates }, req, peer, url), req);
					}
					const scoped = /^\/v1\/([^/]+)\/(chat\/completions|responses|messages)$/.exec(pathname);
					if (scoped) {
						const provider = scoped[1] as ProviderId;
						if (!PROVIDERS.includes(provider)) {
							return withProxyCors(json(404, { error: "unknown provider" }), req);
						}
						const route = ROUTES[`/v1/${scoped[2]}`];
						return withProxyCors(
							await handleChat(route, { boot, sessionStates }, req, peer, url, provider),
							req,
						);
					}
				}
				const uiFile = req.method === "GET" ? UI_FILES[pathname] : undefined;
				if (uiFile) {
					return withProxyCors(new Response(Bun.file(uiFile.path), { headers: { "Content-Type": uiFile.type } }), req);
				}
				return withProxyCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				return withProxyCors(json(500, { error: String(error) }), req);
			}
		},
	});
	console.log(`omp-proxy listening on http://${server.hostname}:${server.port}`);
}

await serve();
