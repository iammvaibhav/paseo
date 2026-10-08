// Thinking levels. The proxy applies omp's own session rules to every
// request, so a client of the proxy gets the level an omp session would run
// at: the same choices (off, auto, the model's efforts), the same default
// (the model's catalog default, else the `defaultThinkingLevel` setting) and
// the same `auto` classifier (omp's judge role, TypeSafe jev when signed in).
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AuthGatewayParsedRequest as ParsedFormatRequest } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { classifyDifficulty } from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { cfgMagicKeyword, cfgMagicKeywordsEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { clampAutoThinkingEffort, resolveProvisionalAutoLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";

const AUTO = "auto";
const OFF = "off";

/** Same budget omp gives the per-turn classifier before it keeps the previous level. */
const AUTO_CLASSIFY_TIMEOUT_MS = 4000;
const AUTO_SESSION_LIMIT = 5000;

/** A thinking selector as omp offers it: off, auto, or a concrete effort. */
export type ThinkingSelector = typeof OFF | typeof AUTO | Effort;

/**
 * How the level was chosen: the client asked for `auto`, named a level, sent
 * nothing (omp's default applies), or the model does not reason.
 */
export type ThinkingSource = "auto" | "explicit" | "default" | "none";

export interface ThinkingDecision {
	/** What the client asked for, as sent: `auto`, `none`, `high`, `budget:4096`, or `default` when it sent nothing. */
	requested: string;
	source: ThinkingSource;
	/** Effective level for this request; null when the model does not reason. */
	resolved: typeof OFF | Effort | null;
	/** Time spent classifying an `auto` turn; null when no classification ran. */
	classifyMs: number | null;
}

function isEffort(value: unknown): value is Effort {
	return typeof value === "string" && (THINKING_EFFORTS as readonly string[]).includes(value);
}

/** The selectors omp offers for `model`, in omp's order: off, auto, then the model's efforts. */
export function thinkingSelectors(model: Model<Api>): ThinkingSelector[] {
	if (!model.reasoning) return [];
	return [OFF, AUTO, ...getSupportedEfforts(model)];
}

/**
 * The level an omp session starts at for `model` (pi-coding-agent sdk.ts
 * `pickInitialThinkingLevel`): the model's catalog default, else the
 * `defaultThinkingLevel` setting, clamped to the model's efforts.
 */
export function defaultSelector(model: Model<Api>, settings: Settings): typeof AUTO | Effort | undefined {
	if (!model.reasoning) return undefined;
	const configured: string = model.thinking?.defaultLevel ?? cfgDefaultThinkingLevel.get(settings);
	if (configured === AUTO) return AUTO;
	return isEffort(configured) ? clampThinkingLevelForModel(model, configured) : undefined;
}

/**
 * The raw selector a request names, read from the body because pi-ai's wire
 * parsers drop the values omp adds (`auto`, Responses `none`, `minimal` on the
 * Messages wire).
 */
function rawSelector(body: unknown, format: string): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const data = body as {
		reasoning_effort?: unknown;
		reasoning?: { effort?: unknown };
		output_config?: { effort?: unknown };
	};
	const value =
		format === "openai-chat"
			? (data.reasoning_effort ?? data.reasoning?.effort)
			: format === "openai-responses"
				? data.reasoning?.effort
				: data.output_config?.effort;
	return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/** Effort values each wire's pi-ai request parser accepts; it rejects the rest with a 400. */
const WIRE_EFFORTS: Record<string, readonly string[]> = {
	"openai-chat": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
	"openai-responses": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
	"anthropic-messages": ["low", "medium", "high", "xhigh", "max"],
};

/**
 * The body to hand pi-ai's parser, which rejects with a 400 what omp adds or
 * gateways send: a selector only omp knows (`auto`, `off`, `minimal` on the
 * Messages wire) and JSON nulls in the reasoning section (Bifrost sends
 * `reasoning.summary: null` on the Responses wire) are removed.
 * {@link resolveThinking} reads the selector from the original body.
 */
export function parseableBody(body: unknown, format: string): unknown {
	if (typeof body !== "object" || body === null) return body;
	const raw = rawSelector(body, format);
	const dropSelector = raw !== undefined && !WIRE_EFFORTS[format]?.includes(raw);
	const key = format === "anthropic-messages" ? "output_config" : "reasoning";
	const value = (body as Record<string, unknown>)[key];
	const section =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	const nulls = section ? Object.keys(section).filter(name => section[name] === null) : [];
	if (!dropSelector && nulls.length === 0) return body;
	const copy: Record<string, unknown> = { ...body };
	if (dropSelector && format === "openai-chat") delete copy.reasoning_effort;
	if (section) {
		const kept = { ...section };
		for (const name of nulls) delete kept[name];
		if (dropSelector) delete kept.effort;
		copy[key] = kept;
	}
	return copy;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

/**
 * The user turn a request belongs to. A tool-loop follow-up carries the same
 * user messages as the request that opened the turn, so it maps to the same
 * key and reuses that turn's level, as an omp session does.
 */
function userTurn(parsed: ParsedFormatRequest): { text: string; key: string } {
	let count = 0;
	let text = "";
	for (const message of parsed.context.messages) {
		if (message.role !== "user") continue;
		count++;
		text = messageText(message.content);
	}
	return { text, key: `${count}:${Bun.hash(text)}` };
}

/** Last `auto` level per proxy session, keyed by the user turn it was classified for. */
const autoLevels = new Map<string, { turn: string; effort: Effort }>();

function rememberAuto(sessionId: string, turn: string, effort: Effort): void {
	autoLevels.delete(sessionId);
	autoLevels.set(sessionId, { turn, effort });
	if (autoLevels.size > AUTO_SESSION_LIMIT) {
		const oldest = autoLevels.keys().next().value;
		if (oldest !== undefined) autoLevels.delete(oldest);
	}
}

interface AutoInput {
	parsed: ParsedFormatRequest;
	model: Model<Api>;
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	signal: AbortSignal;
}

/**
 * omp's `auto` (ModelControls.applyAutoThinkingLevel): classify the user turn
 * once with the judge role, `ultrathink` jumps to the top tier, and a failed
 * or slow classification keeps the session's previous level.
 */
async function resolveAuto(input: AutoInput): Promise<{ effort: Effort | undefined; classifyMs: number | null }> {
	const { model, settings } = input;
	if (getSupportedEfforts(model).length === 0) return { effort: undefined, classifyMs: null };
	const turn = userTurn(input.parsed);
	const prior = autoLevels.get(input.sessionId);
	if (prior && prior.turn === turn.key) return { effort: prior.effort, classifyMs: null };

	let effort: Effort | undefined;
	let classifyMs: number | null = null;
	const ultrathink =
		cfgMagicKeywordsEnabled.get(settings) &&
		cfgMagicKeyword.ultrathink.get(settings) &&
		containsMagicKeyword(turn.text, "ultrathink");
	if (ultrathink) {
		effort = clampAutoThinkingEffort(model, Effort.Max);
	} else if (turn.text.trim()) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AUTO_CLASSIFY_TIMEOUT_MS);
		const forwardAbort = () => controller.abort();
		input.signal.addEventListener("abort", forwardAbort, { once: true });
		const startedAt = performance.now();
		try {
			effort = await classifyDifficulty(
				{ request: turn.text },
				{ settings, registry: input.registry, model, sessionId: input.sessionId, signal: controller.signal },
			);
		} catch (error) {
			logger.warn("omp-proxy auto-thinking: classification failed; keeping the previous level", {
				model: `${model.provider}/${model.id}`,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			classifyMs = Math.round(performance.now() - startedAt);
			clearTimeout(timer);
			input.signal.removeEventListener("abort", forwardAbort);
		}
	}
	effort ??= prior?.effort ?? resolveProvisionalAutoLevel(model);
	if (effort !== undefined && !input.signal.aborted) rememberAuto(input.sessionId, turn.key, effort);
	return { effort, classifyMs };
}

/**
 * Decide this request's thinking level the way an omp session would, then
 * write it into `parsed.options` for pi-ai: `off` disables reasoning (pi-ai
 * clamps it to the model's floor where reasoning cannot be turned off), an
 * effort is clamped to the model's efforts, and a request that names nothing
 * gets omp's default.
 */
export async function resolveThinking(input: AutoInput & { body: unknown; format: string }): Promise<ThinkingDecision> {
	const { parsed, model } = input;
	const options = parsed.options;
	const raw = rawSelector(input.body, input.format);
	const off = options.disableReasoning === true || options.forceReasoningOff === true || raw === "none" || raw === OFF;
	const budget = options.explicitThinkingBudgetTokens;
	const requested = off
		? (raw ?? "none")
		: raw !== undefined
			? raw
			: budget !== undefined
				? `budget:${budget}`
				: (options.reasoning ?? "default");

	if (!model.reasoning) {
		options.reasoning = undefined;
		return { requested, source: "none", resolved: null, classifyMs: null };
	}
	if (off) {
		options.reasoning = undefined;
		options.disableReasoning = true;
		return { requested, source: "explicit", resolved: OFF, classifyMs: null };
	}

	let selector: typeof AUTO | Effort | undefined;
	let source: ThinkingSource;
	if (raw === AUTO) {
		selector = AUTO;
		source = "auto";
	} else if (isEffort(raw)) {
		selector = raw;
		source = "explicit";
	} else if (options.reasoning !== undefined || budget !== undefined) {
		// A Messages budget pins onto the requested effort, else High (pi-ai auth gateway).
		selector = options.reasoning ?? Effort.High;
		source = "explicit";
	} else {
		selector = defaultSelector(model, input.settings);
		source = "default";
	}

	let resolved: Effort | undefined;
	let classifyMs: number | null = null;
	if (selector === AUTO) {
		({ effort: resolved, classifyMs } = await resolveAuto(input));
		if (source === "default") source = "auto";
	} else if (selector !== undefined) {
		resolved = clampThinkingLevelForModel(model, selector);
	}
	options.reasoning = resolved;
	options.disableReasoning = undefined;
	options.forceReasoningOff = undefined;
	return { requested, source, resolved: resolved ?? null, classifyMs };
}
