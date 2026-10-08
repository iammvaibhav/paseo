// Chat dispatch. Mirrors `handleFormatEndpoint` + `buildStreamOptions` in
// packages/ai/src/auth-gateway/server.ts:135-223,249-478: foreign wire ->
// parse -> session -> credential -> pi-ai streamSimple/completeSimple ->
// foreign wire. Differences: per-contract model resolution, session-chain
// ids, account pinning, x-omp-* headers, request records. No usage rows
// are written.
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthStorage,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import {
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	normalizeClientSessionKey,
	resolveGatewayAccount,
	resolveGatewayApiKey,
} from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import {
	captureRequestHeaders,
	gatewayResponseHeaders,
	resolvePromptCacheKey,
} from "@oh-my-pi/pi-ai/auth-gateway/http";
import { AuthGatewaySessionStateStore } from "@oh-my-pi/pi-ai/auth-gateway/session-state";
import type {
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
	AuthGatewayStreamControl,
} from "@oh-my-pi/pi-ai/auth-gateway/types";
import { classifyGatewayError } from "@oh-my-pi/pi-ai/error/gateway";
import * as anthropicMessages from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import * as openaiChat from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import * as openaiResponses from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import { completeSimple, streamSimple } from "@oh-my-pi/pi-ai/stream";
import { chainLookup, chainStore } from "./session-chain";
import { ImageInputError, prepareImages, restoreImages } from "./images";
import { aliasFor, parseAccountSpec, pinForRequest } from "./accounts";
import { createRecord, updateRecord } from "./records";
import type { RequestFormat } from "./records";
import type { Boot } from "./boot";
export const ROUTES: Record<string, { module: FormatModule; label: RequestFormat }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};
// Rank via the account-routing plugin without its session-manager context:
// the strategies read quota state, they need no session beyond pins we do.
export function pluginAdapter(): {
	logger: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
} {
	return {
		logger: {
			info: (message, meta) => logger.info(message, meta as Record<string, unknown> | undefined),
			warn: (message, meta) => logger.warn(message, meta as Record<string, unknown> | undefined),
		},
	};
}

function buildStreamOptions(
	parsed: ParsedFormatRequest,
	api: Api,
	signal: AbortSignal,
	sessionId: string,
): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal, cursorExternalToolExecutor: true };
	const { options } = parsed;
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.userProfileId !== undefined) opts.userProfileId = options.userProfileId;
	if (options.headers !== undefined) opts.headers = { ...opts.headers, ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice !== "object"
				? options.toolChoice
				: "type" in options.toolChoice
					? options.toolChoice
					: { type: "tool", name: options.toolChoice.name };
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.forceReasoningOff !== undefined) {
		opts.disableReasoning = options.forceReasoningOff;
		opts.forceReasoningOff = options.forceReasoningOff;
	}
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.anthropicPrefixMismatchBehavior !== undefined) {
		opts.anthropicPrefixMismatchBehavior = options.anthropicPrefixMismatchBehavior;
	}
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.include !== undefined) opts.include = options.include;
	opts.promptCacheKey = sessionId;
	opts.sessionId = sessionId;
	if (options.thinkingBudgets) opts.thinkingBudgets = { ...opts.thinkingBudgets, ...options.thinkingBudgets };
	if (options.explicitThinkingBudgetTokens !== undefined) {
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = { ...opts.thinkingBudgets, [effort]: options.explicitThinkingBudgetTokens };
		opts.reasoning ??= effort;
	}
	if (
		options.parallelToolCalls !== undefined ||
		options.previousResponseId !== undefined ||
		options.seed !== undefined ||
		options.logitBias !== undefined ||
		options.user !== undefined ||
		options.responseFormat !== undefined
	) {
		logger.debug("omp-proxy dropped unsupported typed options", { api });
	}
	return opts;
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

// Per-request `account` / `session` controls: query wins over header.
export function requestControls(req: Request, url: URL): { account: string; session: string | undefined } {
	const account = url.searchParams.get("account") ?? req.headers.get("x-omp-account") ?? "auto";
	const session =
		url.searchParams.get("session") ??
		req.headers.get("x-session-id") ??
		req.headers.get("session_id") ??
		req.headers.get("conversation_id") ??
		req.headers.get("x-prompt-cache-key") ??
		undefined;
	return { account, session: session && session.trim().length > 0 ? session : undefined };
}

function accountLabel(
	storage: AuthStorage,
	provider: string,
	sessionId: string,
	credentialId: number | undefined,
): { label: string; email: string | null } {
	const accounts = storage.oauth.accounts(provider, sessionId);
	const row = credentialId !== undefined ? accounts.find(entry => entry.credentialId === credentialId) : undefined;
	const active = row ?? accounts.find(entry => entry.active);
	if (active) {
		return { label: aliasFor(active) ?? active.email ?? active.accountId ?? String(active.credentialId), email: active.email ?? null };
	}
	if (credentialId !== undefined) return { label: String(credentialId), email: null };
	return { label: "unknown", email: null };
}

function settleUsage(message: AssistantMessage, startedAtMs: number, upstreamTtftMs: number | null) {
	const usage = message.usage;
	const durationMs = message.duration ?? Date.now() - startedAtMs;
	const totalMs = message.completedAt ? message.completedAt - startedAtMs : durationMs;
	const outputPerSec =
		usage.output > 0 && durationMs > 0 ? usage.output / (Math.max(durationMs, 1) / 1000) : null;
	return {
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			reasoningTokens: usage.reasoningTokens ?? 0,
			totalTokens: usage.totalTokens,
		},
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
		timings: { upstreamTtftMs: message.ttft ?? upstreamTtftMs, upstreamDurationMs: durationMs, totalMs },
		outputTokensPerSec: outputPerSec,
		stopReason: message.stopReason,
		responseId: message.responseId ?? null,
	};
}

function readTopModel(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("model" in value)) return undefined;
	return typeof value.model === "string" ? value.model : undefined;
}
export interface DispatchDeps {
	boot: Boot;
	sessionStates: AuthGatewaySessionStateStore;
}

export async function handleChat(
	route: { module: FormatModule; label: RequestFormat },
	deps: DispatchDeps,
	req: Request,
	peer: string,
	url: URL,
	forcedProvider?: string,
): Promise<Response> {
	const startedAt = performance.now();
	const startedAtMs = Date.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const rawModel = readTopModel(body);
	if (!rawModel) return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	const queryProvider = url.searchParams.get("provider");
	const providerHint = forcedProvider ?? queryProvider ?? undefined;
	let lookupKey = rawModel;
	if (!rawModel.includes("/") && providerHint) lookupKey = `${providerHint}/${rawModel}`;
	const model = deps.boot.modelById.get(lookupKey) ?? deps.boot.modelById.get(rawModel);
	if (!model) return route.module.formatError(404, "invalid_request_error", `Unknown model: ${rawModel}`);
	if (forcedProvider && model.provider !== forcedProvider) {
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${rawModel}`);
	}

	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...parsed.options.headers };
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// Images get OMP's paste treatment before the session chain hashes the context.
	try {
		restoreImages(parsed.context, body, route.label);
		await prepareImages(parsed.context, model.provider, controller.signal);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		if (error instanceof ImageInputError) return route.module.formatError(400, "invalid_request_error", error.message);
		throw error;
	}

	const controls = requestControls(req, url);
	// Client session wins; standard pi-ai cache keys count as client keys;
	// else chain to the continued turn; else start a new id.
	const headerKey = controls.session ?? resolvePromptCacheKey(body, req.headers);
	const clientKey = normalizeClientSessionKey(headerKey ?? parsed.options.promptCacheKey);
	let sessionId: string;
	let sessionSource: "client" | "chain" | "new";
	if (clientKey) {
		sessionId = clientKey;
		sessionSource = "client";
	} else {
		const chained = chainLookup(model.provider, parsed.context);
		if (chained) {
			sessionId = chained.sessionId;
			sessionSource = "chain";
		} else {
			sessionId = crypto.randomUUID();
			sessionSource = "new";
		}
	}
	parsed.options.promptCacheKey = sessionId;

	const spec = parseAccountSpec(controls.account);
	if (spec.kind === "invalid") {
		return route.module.formatError(400, "invalid_request_error", `Unknown account: ${spec.value}`);
	}
	try {
		await pinForRequest(
			deps.boot.storage,
			model.provider,
			sessionId,
			spec,
			pluginAdapter(),
			parsed.modelId,
			model.accountAccess && Object.keys(model.accountAccess),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/Unknown account/.test(message)) {
			return route.module.formatError(400, "invalid_request_error", message);
		}
		throw error;
	}
	const proxyOverheadMs = Math.round(performance.now() - startedAt);

	const apiKey = await resolveGatewayApiKey(deps.boot.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return clientClosedResponse(route);
	if ("status" in apiKey) return route.module.formatError(apiKey.status, apiKey.type, apiKey.message);

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal, sessionId);
	const lease = deps.sessionStates.acquire({
		clientKey,
		model,
		context: parsed.context,
		account: resolveGatewayAccount(deps.boot.storage, model.provider, sessionId, apiKey.apiKey),
	});
	streamOpts.providerSessionState = lease.states;
	let resolvedCredentialId: number | undefined;
	try {
		const withCred = await deps.boot.storage.keys.getWithCredential(model.provider, sessionId, {
			modelId: model.id,
			signal: controller.signal,
		});
		resolvedCredentialId = withCred?.credentialId;
	} catch {
		resolvedCredentialId = undefined;
	}
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		deps.boot.storage,
		model,
		sessionId,
		apiKey,
		controller.signal,
		route.label,
		peer,
		resolvedKey => {
			lease.updateAccount(resolveGatewayAccount(deps.boot.storage, model.provider, sessionId, resolvedKey));
		},
	);

	const identity = accountLabel(deps.boot.storage, model.provider, sessionId, resolvedCredentialId);
	const ompHeaders: Record<string, string> = {
		"x-omp-request-id": requestId,
		"x-omp-provider": model.provider,
		"x-omp-model": `${model.provider}/${model.id}`,
		"x-omp-session-id": sessionId,
		"x-omp-session-source": sessionSource,
		"x-omp-account": identity.label,
		"x-omp-credential-id": resolvedCredentialId !== undefined ? String(resolvedCredentialId) : "",
		"x-omp-proxy-overhead-ms": String(proxyOverheadMs),
	};

	createRecord({
		requestId,
		startedAt: startedAtMs,
		format: route.label,
		provider: model.provider,
		model: `${model.provider}/${model.id}`,
		api: model.api,
		upstreamBaseUrl: model.baseUrl,
		stream: parsed.stream,
		session: { id: sessionId, source: sessionSource },
		account:
			resolvedCredentialId !== undefined
				? { credentialId: resolvedCredentialId, label: identity.label, email: identity.email }
				: null,
		status: "pending",
		httpStatus: null,
		error: null,
		stopReason: null,
		responseId: null,
		timings: { proxyOverheadMs, upstreamTtftMs: null, upstreamDurationMs: null, totalMs: null },
		usage: null,
		cost: null,
		outputTokensPerSec: null,
	});

	logger.info("omp-proxy request", {
		requestId,
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	const finishOk = (message: AssistantMessage, httpStatus: number) => {
		if (sessionSource !== "client") chainStore(model.provider, parsed.context, sessionId);
		if (message.credentialId !== undefined) resolvedCredentialId = message.credentialId;
		const settled = settleUsage(message, startedAtMs, null);
		const live = accountLabel(deps.boot.storage, model.provider, sessionId, resolvedCredentialId);
		ompHeaders["x-omp-account"] = live.label;
		ompHeaders["x-omp-credential-id"] = resolvedCredentialId !== undefined ? String(resolvedCredentialId) : "";
		updateRecord(requestId, {
			status: "ok",
			httpStatus,
			stopReason: settled.stopReason,
			responseId: settled.responseId,
			timings: {
				proxyOverheadMs,
				upstreamTtftMs: settled.timings.upstreamTtftMs,
				upstreamDurationMs: settled.timings.upstreamDurationMs,
				totalMs: settled.timings.totalMs,
			},
			usage: settled.usage,
			cost: settled.cost,
			outputTokensPerSec: settled.outputTokensPerSec,
			account:
				resolvedCredentialId !== undefined
					? { credentialId: resolvedCredentialId, label: live.label, email: live.email }
					: null,
		});
		return { ...ompHeaders };
	};

	const finishError = (status: string, httpStatus: number | null, error: string | null) => {
		updateRecord(requestId, {
			status: status as "error" | "aborted",
			httpStatus,
			error,
			timings: { proxyOverheadMs, upstreamTtftMs: null, upstreamDurationMs: null, totalMs: Date.now() - startedAtMs },
		});
	};
	// Error envelopes carry the same x-omp-* headers so clients can look up the record.
	const withOmp = (response: Response): Response => {
		for (const [name, value] of Object.entries(ompHeaders)) response.headers.set(name, value);
		return response;
	};

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) {
				finishError("aborted", 499, "client closed request");
				return clientClosedResponse(route);
			}
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("omp-proxy non-streaming failed", { format: route.label, reason: message.stopReason, peer });
				if (message.stopReason === "aborted") {
					finishError("aborted", 499, errorMessage);
					return withOmp(route.module.formatError(499, "request_aborted", errorMessage));
				}
				const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
				finishError("error", classified.status, errorMessage);
				return withOmp(route.module.formatError(classified.status, classified.type, errorMessage));
			}
		const liveHeaders = finishOk(message, 200);
		const headers = { ...gatewayResponseHeaders(model, { requestId, costUsd: message.usage.cost.total, startedAt }), ...liveHeaders };
		return new Response(JSON.stringify(route.module.encodeResponse(message, parsed.modelId)), {
			status: 200,
			headers: { "Content-Type": "application/json", ...headers },
		});
		} catch (error) {
			if (controller.signal.aborted) {
				finishError("aborted", 499, "client closed request");
				return clientClosedResponse(route);
			}
			const classified = classifyGatewayError(error);
			logger.warn("omp-proxy non-streaming aborted", { format: route.label, peer });
			finishError("error", classified.status, classified.message);
			return withOmp(route.module.formatError(classified.status, classified.type, classified.message));
		} finally {
			lease.release();
		}
	}

	let streamOwnsLease = false;
	try {
		let events: AssistantMessageEventStream;
		try {
			if (controller.signal.aborted) {
				finishError("aborted", 499, "client closed request");
				return clientClosedResponse(route);
			}
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logger.warn("omp-proxy streamSimple threw", { format: route.label, peer });
			finishError("error", classified.status, classified.message);
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
		if (controller.signal.aborted) {
			finishError("aborted", 499, "client closed request");
			return clientClosedResponse(route);
		}
		let settled = false;
		void events
			.result()
			.then(message => {
				settled = true;
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					const errorMessage = message.errorMessage ?? "Upstream request failed";
					const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
					finishError(message.stopReason, message.stopReason === "aborted" ? 499 : classified.status, errorMessage);
					return;
				}
				finishOk(message, 200);
			})
			.catch((error: unknown) => {
				if (settled) return;
				const classified = classifyGatewayError(error);
				finishError("error", classified.status, classified.message);
			})
			.finally(() => lease.release());
		streamOwnsLease = true;

		const control: AuthGatewayStreamControl = {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		};
		const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, control);
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				...ompHeaders,
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	} finally {
		if (!streamOwnsLease) lease.release();
	}
}
