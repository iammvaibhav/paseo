"use strict";

/*
 * omp-proxy playground.
 * Vanilla JavaScript. It uses only the HTTP contract of the proxy.
 */

// ── Contract constants ───────────────────────────────────────────────────

const PROVIDERS = Object.freeze([
	{ id: "google-antigravity", label: "Antigravity" },
	{ id: "anthropic", label: "Claude" },
	{ id: "openai-codex", label: "Codex" },
	{ id: "cursor", label: "Cursor" },
	{ id: "grok-build", label: "Grok Build" },
	{ id: "opencode-go", label: "OpenCode Go" },
]);

const FORMAT_PATHS = Object.freeze({
	chat: "chat/completions",
	responses: "responses",
	messages: "messages",
});

const STORAGE_KEYS = Object.freeze({
	token: "omp-proxy.token",
	settings: "omp-proxy.settings.v1",
	history: "omp-proxy.history.v1",
});

const HISTORY_LIMIT = 50;
const POLL_INTERVAL_MS = 300;
const POLL_TIMEOUT_MS = 10_000;
const STORED_RESPONSE_CHARS = 120_000;
const FALLBACK_MAX_TOKENS = 4096;
const METRICS_REPAINT_MS = 100;
const INSPECTOR_REPAINT_MS = 400;
const TOAST_MS = 1600;
const HINT_MS = 2400;
const NEAR_END_PX = 64;

const DEFAULT_SETTINGS = Object.freeze({
	model: null,
	account: "auto",
	effort: "default",
	format: "chat",
	stream: true,
	maxTokens: "4096",
	temperature: "",
	sessionMode: "auto",
	sessionId: "",
});

const SERVER_STATE_TEXT = Object.freeze({
	idle: "Waits for the run to finish.",
	polling: "Polling /api/requests until the turn settles…",
	done: "Settled.",
	timeout: "The record is still pending after 10 s.",
	missing: "No x-omp-request-id header. The server did not dispatch this request.",
	interrupted: "The page closed before the record settled.",
	error: "Record fetch failed.",
});

// ── State ────────────────────────────────────────────────────────────────

const state = {
	token: "",
	health: { status: "loading", version: null, error: null },
	providers: PROVIDERS.map(baseProvider),
	providersStatus: "loading",
	providersError: null,
	models: {},
	current: PROVIDERS[0].id,
	settings: {},
	systemPrompt: "",
	conversations: {},
	runs: [],
	selectedRunId: null,
	active: null,
	runTab: "metrics",
};

const ui = {};
const turnElements = new WeakMap();
let defaultComposerHint = [];
let paintQueued = false;
let lastInspectorPaint = 0;
let lastPanelKey = "";
let inspectorTimer = 0;
let toastTimer = 0;
let hintTimer = 0;

function baseProvider(p) {
	return { id: p.id, label: p.label, accounts: [], routing: null, defaultModel: null, modelCount: null, listed: false };
}

// ── Small helpers ────────────────────────────────────────────────────────

function h(tag, props, ...children) {
	const el = document.createElement(tag);
	if (props) {
		for (const [key, value] of Object.entries(props)) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "class") el.className = value;
			else if (key === "text") el.textContent = value;
			else if (key === "dataset") Object.assign(el.dataset, value);
			else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
			else if (typeof value === "boolean" && key in el) el[key] = value;
			else el.setAttribute(key, value === true ? "" : String(value));
		}
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : String(child));
	}
	return el;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function headerNumber(value) {
	if (typeof value !== "string" || value.trim() === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function prettyJson(value) {
	return JSON.stringify(value, null, 2);
}

function prettyText(text) {
	const json = typeof text === "string" ? parseJson(text) : undefined;
	return json === undefined ? (text ?? "") : prettyJson(json);
}

function errorText(err) {
	if (err instanceof Error) return err.message || err.name;
	return String(err);
}

function randomHex(bytes) {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

// crypto.randomUUID needs a secure context. getRandomValues does not.
function newSessionId() {
	const hex = randomHex(16).split("");
	hex[12] = "4";
	hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
	const s = hex.join("");
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function firstString(...values) {
	for (const value of values) if (typeof value === "string" && value.length > 0) return value;
	return null;
}

function bareModelId(providerId, id) {
	const prefix = `${providerId}/`;
	return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ── Formatters ───────────────────────────────────────────────────────────

function fmtMs(ms) {
	const v = num(ms);
	if (v === null) return "—";
	if (v < 1000) return `${Math.round(v)} ms`;
	return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
}

function fmtInt(n) {
	const v = num(n);
	return v === null ? "—" : Math.round(v).toLocaleString("en-US");
}

function fmtRate(n) {
	const v = num(n);
	if (v === null) return "—";
	return v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);
}

function fmtUsd(n) {
	const v = num(n);
	if (v === null) return "—";
	if (v === 0) return "$0";
	if (v < 0.0001) return "<$0.0001";
	return `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
}

function fmtPct(ratio) {
	const v = num(ratio);
	return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtCompact(n) {
	const v = num(n);
	if (v === null) return null;
	if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1000) return `${Math.round(v / 1000)}K`;
	return String(v);
}

function fmtClock(ms) {
	return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

function shortId(id) {
	return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

// ── Storage ──────────────────────────────────────────────────────────────

function readStorage(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key, value) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}

function readStoredJson(key) {
	const raw = readStorage(key);
	if (!raw) return null;
	const value = parseJson(raw);
	return value === undefined ? null : value;
}

function sanitizeSettings(raw) {
	const out = { ...DEFAULT_SETTINGS };
	if (!isRecord(raw)) return out;
	if (typeof raw.model === "string") out.model = raw.model;
	if (str(raw.account)) out.account = raw.account;
	if (str(raw.effort)) out.effort = raw.effort;
	if (Object.hasOwn(FORMAT_PATHS, raw.format)) out.format = raw.format;
	if (typeof raw.stream === "boolean") out.stream = raw.stream;
	if (typeof raw.maxTokens === "string") out.maxTokens = raw.maxTokens;
	if (typeof raw.temperature === "string") out.temperature = raw.temperature;
	if (raw.sessionMode === "auto" || raw.sessionMode === "fixed") out.sessionMode = raw.sessionMode;
	if (typeof raw.sessionId === "string") out.sessionId = raw.sessionId;
	return out;
}

function restoreState() {
	state.token = readStorage(STORAGE_KEYS.token) ?? "";
	const saved = readStoredJson(STORAGE_KEYS.settings);
	if (isRecord(saved)) {
		if (PROVIDERS.some(p => p.id === saved.current)) state.current = saved.current;
		if (typeof saved.systemPrompt === "string") state.systemPrompt = saved.systemPrompt;
		if (isRecord(saved.providers)) {
			for (const p of PROVIDERS) {
				if (isRecord(saved.providers[p.id])) state.settings[p.id] = sanitizeSettings(saved.providers[p.id]);
			}
		}
	}
	const history = readStoredJson(STORAGE_KEYS.history);
	if (Array.isArray(history)) {
		state.runs = history.filter(isStoredRun).slice(0, HISTORY_LIMIT).map(reviveRun);
	}
	state.selectedRunId = state.runs[0]?.id ?? null;
}

function persistSettings() {
	writeStorage(
		STORAGE_KEYS.settings,
		JSON.stringify({ current: state.current, systemPrompt: state.systemPrompt, providers: state.settings }),
	);
}

function isStoredRun(run) {
	return (
		isRecord(run) &&
		typeof run.id === "string" &&
		typeof run.provider === "string" &&
		typeof run.startedAt === "number" &&
		isRecord(run.request) &&
		isRecord(run.response) &&
		isRecord(run.client)
	);
}

function reviveRun(run) {
	const out = { ...run, wire: isRecord(run.wire) ? run.wire : { usage: null, stopReason: null } };
	out.output = { text: "", reasoning: "" };
	if (!Array.isArray(out.response.events)) out.response.events = [];
	if (out.status === "running") {
		out.status = "aborted";
		out.error = "The page closed before the run finished.";
	}
	if (out.serverState === "polling" || out.serverState === "idle") out.serverState = "interrupted";
	return out;
}

// Stored runs keep a bounded response so localStorage stays small.
function compactRun(run) {
	const response = { ...run.response, truncated: run.response.truncated === true };
	if (response.events.length > 0) {
		let used = 0;
		const kept = [];
		for (const ev of response.events) {
			used += ev.data.length;
			if (used > STORED_RESPONSE_CHARS) {
				response.truncated = true;
				break;
			}
			kept.push(ev);
		}
		response.events = kept;
	}
	if (typeof response.body === "string" && response.body.length > STORED_RESPONSE_CHARS) {
		response.body = response.body.slice(0, STORED_RESPONSE_CHARS);
		response.truncated = true;
	}
	const { output: _output, ...rest } = run;
	return { ...rest, response };
}

function persistHistory() {
	let list = state.runs.filter(r => r.status !== "running").slice(0, HISTORY_LIMIT).map(compactRun);
	while (list.length > 0 && !writeStorage(STORAGE_KEYS.history, JSON.stringify(list))) {
		list = list.slice(0, Math.floor((list.length * 3) / 4));
	}
	if (list.length === 0) writeStorage(STORAGE_KEYS.history, null);
}

// ── Derived data ─────────────────────────────────────────────────────────

function settingsFor(providerId) {
	let s = state.settings[providerId];
	if (!s) {
		s = { ...DEFAULT_SETTINGS };
		state.settings[providerId] = s;
	}
	return s;
}

function conversationFor(providerId) {
	let c = state.conversations[providerId];
	if (!c) {
		c = { turns: [], lastSession: null };
		state.conversations[providerId] = c;
	}
	return c;
}

function currentProvider() {
	return state.providers.find(p => p.id === state.current) ?? baseProvider(PROVIDERS[0]);
}

function modelsFor(providerId) {
	return state.models[providerId] ?? { status: "idle", list: [], error: null };
}

function currentModel() {
	const s = settingsFor(state.current);
	const entry = modelsFor(state.current);
	return entry.list.find(m => m.id === s.model) ?? null;
}

function findRun(id) {
	return state.runs.find(r => r.id === id) ?? null;
}

function ompInfo(run) {
	const hd = run.response.headers ?? {};
	return {
		requestId: str(hd["x-omp-request-id"]),
		provider: str(hd["x-omp-provider"]),
		model: str(hd["x-omp-model"]),
		sessionId: str(hd["x-omp-session-id"]) ?? str(run.record?.session?.id),
		sessionSource: str(hd["x-omp-session-source"]) ?? str(run.record?.session?.source),
		account: str(hd["x-omp-account"]),
		credentialId: str(hd["x-omp-credential-id"]),
		overheadMs: headerNumber(hd["x-omp-proxy-overhead-ms"]),
		thinking: str(hd["x-omp-thinking"]) ?? str(run.record?.thinking?.resolved),
		thinkingSource: str(hd["x-omp-thinking-source"]) ?? str(run.record?.thinking?.source),
		cost: headerNumber(hd["x-litellm-response-cost"]),
		durationMs: headerNumber(hd["x-litellm-response-duration-ms"]),
	};
}

function usageOf(run) {
	if (isRecord(run.record?.usage)) return { usage: run.record.usage, source: "server" };
	if (isRecord(run.wire?.usage)) return { usage: run.wire.usage, source: "wire" };
	return { usage: null, source: null };
}

function costOf(run) {
	return num(run.record?.cost?.total) ?? ompInfo(run).cost;
}

function cacheHitRatio(usage) {
	if (!usage) return null;
	const input = num(usage.input) ?? 0;
	const read = num(usage.cacheRead) ?? 0;
	const write = num(usage.cacheWrite) ?? 0;
	const denominator = input + read + write;
	return denominator > 0 ? read / denominator : null;
}

function charsPerSecond(run) {
	const chars = run.client.outputChars + run.client.reasoningChars;
	if (chars === 0) return null;
	const ttft = num(run.client.ttftMs);
	const end = num(run.client.totalMs) ?? (state.active?.run === run ? performance.now() - state.active.t0 : null);
	if (end === null) return null;
	const window = run.stream && ttft !== null ? end - ttft : end;
	return window > 0 ? chars / (window / 1000) : null;
}

function accountText(run) {
	const omp = ompInfo(run);
	if (omp.account) return omp.account;
	const acct = run.record?.account;
	if (isRecord(acct)) return acct.label ?? acct.email ?? `#${acct.credentialId}`;
	return run.accountRequested;
}

function sessionTone(source) {
	if (source === "client") return "info";
	if (source === "chain") return "ok";
	if (source === "new") return "accent";
	return undefined;
}

function statusTone(status) {
	if (status === "ok") return "ok";
	if (status === "error") return "error";
	if (status === "aborted") return "warn";
	if (status === "running" || status === "pending") return "accent";
	return undefined;
}

// ── Network: shared ──────────────────────────────────────────────────────

function authHeaders() {
	const token = state.token.trim();
	return token ? { authorization: `Bearer ${token}` } : {};
}

function apiGet(path) {
	return fetch(path, { headers: { accept: "application/json", ...authHeaders() } });
}

async function readBody(res) {
	const text = await res.text();
	return { text, json: text ? parseJson(text) : undefined };
}

// Reads the OpenAI and Anthropic error envelopes.
function envelopeMessage(json) {
	if (!isRecord(json)) return null;
	const e = json.error;
	if (typeof e === "string") return e;
	if (isRecord(e) && typeof e.message === "string") return e.type ? `${e.message} (${e.type})` : e.message;
	if (typeof json.message === "string") return json.message;
	return null;
}

function describeHttpError(res, body) {
	const detail = envelopeMessage(body.json) ?? (body.text ? body.text.slice(0, 600) : null);
	return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${detail ? ` — ${detail}` : ""}`;
}

function headersObject(headers) {
	const out = {};
	for (const [key, value] of headers.entries()) out[key] = value;
	return out;
}

// ── Network: catalog ─────────────────────────────────────────────────────

async function loadHealth() {
	try {
		const res = await apiGet("/healthz");
		const body = await readBody(res);
		if (!res.ok || body.json?.ok !== true) throw new Error(describeHttpError(res, body));
		state.health = { status: "ok", version: str(body.json.version), error: null };
	} catch (err) {
		state.health = { status: "error", version: null, error: errorText(err) };
	}
	renderHealth();
}

async function loadProviders() {
	state.providersStatus = "loading";
	try {
		const res = await apiGet("/api/providers");
		const body = await readBody(res);
		if (!res.ok || !Array.isArray(body.json?.providers)) throw new Error(describeHttpError(res, body));
		const listed = body.json.providers.filter(p => isRecord(p) && PROVIDERS.some(base => base.id === p.id));
		const byId = new Map(listed.map(p => [p.id, p]));
		const order = [...listed.map(p => p.id), ...PROVIDERS.map(p => p.id).filter(id => !byId.has(id))];
		state.providers = order.map(id => {
			const base = baseProvider(PROVIDERS.find(p => p.id === id));
			const p = byId.get(id);
			if (!p) return base;
			return {
				...base,
				label: str(p.label) ?? base.label,
				accounts: Array.isArray(p.accounts) ? p.accounts.filter(isRecord) : [],
				routing: isRecord(p.routing) ? p.routing : null,
				defaultModel: str(p.defaultModel),
				modelCount: num(p.modelCount),
				listed: true,
			};
		});
		state.providersStatus = "ok";
		state.providersError = null;
	} catch (err) {
		state.providersStatus = "error";
		state.providersError = errorText(err);
	}
	renderPills();
	renderControls();
	renderPreview();
}

async function loadModels(providerId, force = false) {
	const entry = modelsFor(providerId);
	if (!force && (entry.status === "ok" || entry.status === "loading")) return;
	state.models[providerId] = { status: "loading", list: [], error: null };
	if (providerId === state.current) renderControls();
	try {
		const res = await apiGet(`/v1/${encodeURIComponent(providerId)}/models`);
		const body = await readBody(res);
		if (!res.ok || !Array.isArray(body.json?.data)) throw new Error(describeHttpError(res, body));
		const list = body.json.data.filter(m => isRecord(m) && typeof m.id === "string");
		state.models[providerId] = { status: "ok", list, error: null };
		ensureModelSelection(providerId);
	} catch (err) {
		state.models[providerId] = { status: "error", list: [], error: errorText(err) };
	}
	if (providerId === state.current) {
		renderControls();
		renderPreview();
		renderTranscriptChrome();
	}
}

function ensureModelSelection(providerId) {
	const s = settingsFor(providerId);
	const list = modelsFor(providerId).list;
	if (list.some(m => m.id === s.model)) return;
	const provider = state.providers.find(p => p.id === providerId);
	const dm = provider?.defaultModel;
	const preferred = dm ? list.find(m => m.id === dm || m.id === `${providerId}/${dm}`) : null;
	s.model = (preferred ?? list[0])?.id ?? null;
	persistSettings();
}

// ── Request building ─────────────────────────────────────────────────────

function historyMessages(providerId) {
	return conversationFor(providerId)
		.turns.filter(t => !t.excluded && t.state !== "running")
		.map(t => ({ role: t.role, content: t.content }));
}

function parsedMaxTokens(s) {
	const n = Number.parseInt(s.maxTokens, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function parsedTemperature(s) {
	if (s.temperature.trim() === "") return null;
	const n = Number(s.temperature);
	return Number.isFinite(n) ? n : null;
}

function buildRequest(pendingText) {
	const provider = currentProvider();
	const s = settingsFor(provider.id);
	const model = currentModel();
	const turns = historyMessages(provider.id);
	if (pendingText) turns.push({ role: "user", content: pendingText });

	const params = new URLSearchParams({ account: s.account || "auto" });
	const sessionId = s.sessionMode === "fixed" ? s.sessionId.trim() : "";
	if (sessionId) params.set("session", sessionId);
	const path = `/v1/${encodeURIComponent(provider.id)}/${FORMAT_PATHS[s.format]}?${params}`;

	const system = state.systemPrompt.trim() ? state.systemPrompt : null;
	const maxTokens = parsedMaxTokens(s);
	const temperature = parsedTemperature(s);
	// The proxy reads omp's selectors on every wire: off, auto, or an effort.
	const effort = s.effort !== "default" ? s.effort : null;
	const body = { model: model ? bareModelId(provider.id, model.id) : "" };

	if (s.format === "chat") {
		body.messages = system ? [{ role: "system", content: system }, ...turns] : turns;
		if (maxTokens !== null) body.max_tokens = maxTokens;
		if (effort) body.reasoning_effort = effort === "off" ? "none" : effort;
	} else if (s.format === "responses") {
		if (system) body.instructions = system;
		body.input = turns;
		if (maxTokens !== null) body.max_output_tokens = maxTokens;
		if (effort) body.reasoning = { effort: effort === "off" ? "none" : effort };
	} else {
		if (system) body.system = system;
		body.messages = turns;
		// The Messages wire requires max_tokens.
		body.max_tokens = maxTokens ?? num(model?.max_output_tokens) ?? FALLBACK_MAX_TOKENS;
		if (effort === "off") body.thinking = { type: "disabled" };
		else if (effort) body.output_config = { effort };
	}
	if (temperature !== null) body.temperature = temperature;
	body.stream = s.stream;
	if (s.format === "chat" && s.stream) body.stream_options = { include_usage: true };

	return { method: "POST", path, url: `${location.origin}${path}`, headers: { "content-type": "application/json" }, body };
}

function redactedHeaders(headers) {
	return state.token.trim() ? { ...headers, authorization: "Bearer •••" } : { ...headers };
}

function requestText(request) {
	const lines = [`${request.method} ${request.url}`];
	for (const [key, value] of Object.entries(request.headers)) lines.push(`${key}: ${value}`);
	return `${lines.join("\n")}\n\n${prettyJson(request.body)}`;
}

function curlCommand(request) {
	const parts = [`curl -sS${request.body.stream ? " -N" : ""} ${shellQuote(request.url)}`];
	for (const [key, value] of Object.entries(request.headers)) parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
	if (state.token.trim()) parts.push(`-H "authorization: Bearer $OMP_PROXY_TOKEN"`);
	parts.push("--data-binary @- <<'JSON'");
	return `${parts.join(" \\\n  ")}\n${prettyJson(request.body)}\nJSON\n`;
}

// ── Response parsing ─────────────────────────────────────────────────────

function usageFromChat(u) {
	if (!isRecord(u)) return null;
	const cacheRead = num(u.prompt_tokens_details?.cached_tokens) ?? 0;
	const prompt = num(u.prompt_tokens) ?? 0;
	const output = num(u.completion_tokens) ?? 0;
	return {
		input: Math.max(prompt - cacheRead, 0),
		output,
		cacheRead,
		cacheWrite: null,
		reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
		totalTokens: num(u.total_tokens) ?? prompt + output,
	};
}

function usageFromResponses(u) {
	if (!isRecord(u)) return null;
	const cacheRead = num(u.input_tokens_details?.cached_tokens) ?? 0;
	const input = num(u.input_tokens) ?? 0;
	const output = num(u.output_tokens) ?? 0;
	return {
		input: Math.max(input - cacheRead, 0),
		output,
		cacheRead,
		cacheWrite: null,
		reasoningTokens: num(u.output_tokens_details?.reasoning_tokens),
		totalTokens: num(u.total_tokens) ?? input + output,
	};
}

function usageFromMessages(u, previous) {
	if (!isRecord(u)) return previous;
	const input = num(u.input_tokens) ?? previous?.input ?? 0;
	const cacheRead = num(u.cache_read_input_tokens) ?? previous?.cacheRead ?? 0;
	const cacheWrite = num(u.cache_creation_input_tokens) ?? previous?.cacheWrite ?? 0;
	const output = num(u.output_tokens) ?? previous?.output ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoningTokens: null,
		totalTokens: input + cacheRead + cacheWrite + output,
	};
}

function handleChatData(run, data, sink) {
	if (data === "[DONE]") return;
	const json = parseJson(data);
	if (!isRecord(json)) return;
	if (json.error) {
		sink.error(envelopeMessage(json) ?? "Stream error.");
		return;
	}
	for (const choice of Array.isArray(json.choices) ? json.choices : []) {
		const delta = isRecord(choice.delta) ? choice.delta : {};
		const reasoning = firstString(delta.reasoning_content, delta.reasoning, delta.reasoning_text);
		if (reasoning) sink.reasoning(reasoning);
		if (typeof delta.content === "string") sink.text(delta.content);
		if (str(choice.finish_reason)) run.wire.stopReason = choice.finish_reason;
	}
	if (isRecord(json.usage)) run.wire.usage = usageFromChat(json.usage);
}

function handleResponsesData(run, data, sink) {
	if (data === "[DONE]") return;
	const json = parseJson(data);
	if (!isRecord(json)) return;
	switch (json.type) {
		case "response.output_text.delta":
			if (typeof json.delta === "string") sink.text(json.delta);
			break;
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
			if (typeof json.delta === "string") sink.reasoning(json.delta);
			break;
		case "response.completed":
		case "response.incomplete":
		case "response.failed": {
			const r = isRecord(json.response) ? json.response : {};
			if (isRecord(r.usage)) run.wire.usage = usageFromResponses(r.usage);
			run.wire.stopReason = str(r.incomplete_details?.reason) ?? str(r.status);
			if (json.type === "response.failed") sink.error(str(r.error?.message) ?? "Response failed.");
			break;
		}
		case "error":
			sink.error(str(json.message) ?? envelopeMessage(json) ?? "Stream error.");
			break;
	}
}

function handleMessagesData(run, data, sink) {
	const json = parseJson(data);
	if (!isRecord(json)) return;
	switch (json.type) {
		case "message_start":
			run.wire.usage = usageFromMessages(json.message?.usage, null);
			break;
		case "content_block_delta":
			if (json.delta?.type === "text_delta") sink.text(json.delta.text);
			else if (json.delta?.type === "thinking_delta") sink.reasoning(json.delta.thinking);
			break;
		case "message_delta":
			if (str(json.delta?.stop_reason)) run.wire.stopReason = json.delta.stop_reason;
			run.wire.usage = usageFromMessages(json.usage, run.wire.usage);
			break;
		case "error":
			sink.error(envelopeMessage(json) ?? "Stream error.");
			break;
	}
}

const STREAM_HANDLERS = { chat: handleChatData, responses: handleResponsesData, messages: handleMessagesData };

function parseNonStream(run, json, sink) {
	if (!isRecord(json)) {
		sink.error("The response body is not a JSON object.");
		return;
	}
	if (json.type === "error" || (json.error && !json.choices && !json.output && !json.content)) {
		sink.error(envelopeMessage(json) ?? "Error envelope.");
		return;
	}
	if (run.format === "chat") {
		const choice = Array.isArray(json.choices) ? json.choices[0] : null;
		const msg = isRecord(choice?.message) ? choice.message : {};
		const reasoning = firstString(msg.reasoning_content, msg.reasoning, msg.reasoning_text);
		if (reasoning) sink.reasoning(reasoning);
		if (typeof msg.content === "string") sink.text(msg.content);
		run.wire.stopReason = str(choice?.finish_reason);
		run.wire.usage = usageFromChat(json.usage);
	} else if (run.format === "responses") {
		for (const item of Array.isArray(json.output) ? json.output : []) {
			if (item?.type === "reasoning") {
				for (const part of [...(item.summary ?? []), ...(item.content ?? [])]) {
					if (typeof part?.text === "string") sink.reasoning(part.text);
				}
			} else if (item?.type === "message") {
				for (const part of Array.isArray(item.content) ? item.content : []) {
					if (part?.type === "output_text" && typeof part.text === "string") sink.text(part.text);
				}
			}
		}
		run.wire.stopReason = str(json.incomplete_details?.reason) ?? str(json.status);
		run.wire.usage = usageFromResponses(json.usage);
		if (json.status === "failed") sink.error(str(json.error?.message) ?? "Response failed.");
	} else {
		for (const block of Array.isArray(json.content) ? json.content : []) {
			if (block?.type === "text" && typeof block.text === "string") sink.text(block.text);
			else if (block?.type === "thinking" && typeof block.thinking === "string") sink.reasoning(block.thinking);
		}
		run.wire.stopReason = str(json.stop_reason);
		run.wire.usage = usageFromMessages(json.usage, null);
	}
}

function dispatchSseFrame(frame, run, sink, t0) {
	let event = null;
	const data = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line === "" || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0) return;
	const payload = data.join("\n");
	run.response.events.push({ t: Math.round(performance.now() - t0), event, data: payload });
	STREAM_HANDLERS[run.format](run, payload, sink);
}

async function consumeSse(body, run, sink, t0) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const boundary = /\r?\n\r?\n/;
	let buffer = "";
	const drain = () => {
		let match = boundary.exec(buffer);
		while (match) {
			dispatchSseFrame(buffer.slice(0, match.index), run, sink, t0);
			buffer = buffer.slice(match.index + match[0].length);
			match = boundary.exec(buffer);
		}
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		drain();
	}
	buffer += decoder.decode();
	drain();
	if (buffer.trim()) dispatchSseFrame(buffer, run, sink, t0);
}

// ── Runs ─────────────────────────────────────────────────────────────────

function createRun(provider, s, model, request) {
	return {
		id: `run-${Date.now().toString(36)}-${randomHex(4)}`,
		startedAt: Date.now(),
		provider: provider.id,
		providerLabel: provider.label,
		model: bareModelId(provider.id, model.id),
		modelName: str(model.display_name) ?? bareModelId(provider.id, model.id),
		format: s.format,
		stream: s.stream,
		accountRequested: s.account,
		sessionMode: s.sessionMode,
		request: { method: request.method, url: request.url, headers: redactedHeaders(request.headers), body: request.body },
		response: { status: null, statusText: "", headers: {}, kind: null, events: [], body: null, truncated: false },
		client: { ttfbMs: null, ttftMs: null, totalMs: null, outputChars: 0, reasoningChars: 0 },
		output: { text: "", reasoning: "" },
		wire: { usage: null, stopReason: null },
		status: "running",
		error: null,
		serverState: "idle",
		serverError: null,
		record: null,
	};
}

function createSink(active) {
	const { run, turn } = active;
	const firstToken = () => {
		if (run.client.ttftMs === null) run.client.ttftMs = performance.now() - active.t0;
	};
	return {
		errorMessage: null,
		text(delta) {
			if (typeof delta !== "string" || delta.length === 0) return;
			firstToken();
			run.output.text += delta;
			turn.content += delta;
			run.client.outputChars += delta.length;
			schedulePaint();
		},
		reasoning(delta) {
			if (typeof delta !== "string" || delta.length === 0) return;
			firstToken();
			run.output.reasoning += delta;
			turn.reasoning += delta;
			run.client.reasoningChars += delta.length;
			schedulePaint();
		},
		error(message) {
			this.errorMessage ??= message;
		},
	};
}

async function executeRun(active, request) {
	const { run, controller } = active;
	const sink = createSink(active);
	active.t0 = performance.now();
	try {
		const res = await fetch(request.path, {
			method: request.method,
			headers: { ...request.headers, ...authHeaders() },
			body: JSON.stringify(request.body),
			signal: controller.signal,
		});
		run.client.ttfbMs = performance.now() - active.t0;
		run.response.status = res.status;
		run.response.statusText = res.statusText;
		run.response.headers = headersObject(res.headers);
		schedulePaint();
		const contentType = res.headers.get("content-type") ?? "";
		if (!res.ok) {
			const body = await readBody(res);
			run.response.kind = "body";
			run.response.body = body.text;
			throw new Error(describeHttpError(res, body));
		}
		if (contentType.includes("text/event-stream") && res.body) {
			run.response.kind = "sse";
			await consumeSse(res.body, run, sink, active.t0);
		} else {
			const body = await readBody(res);
			run.response.kind = "body";
			run.response.body = body.text;
			parseNonStream(run, body.json, sink);
		}
		run.client.totalMs = performance.now() - active.t0;
		return sink.errorMessage ? { status: "error", error: sink.errorMessage } : { status: "ok", error: null };
	} catch (err) {
		run.client.totalMs = performance.now() - active.t0;
		if (controller.signal.aborted) return { status: "aborted", error: "Aborted in the browser." };
		return { status: "error", error: errorText(err) };
	}
}

async function send() {
	if (state.active) return;
	const text = ui.composerInput.value;
	if (!text.trim()) {
		flashComposerHint("Type a message first.");
		ui.composerInput.focus();
		return;
	}
	const provider = currentProvider();
	const s = settingsFor(provider.id);
	const model = currentModel();
	if (!model) {
		flashComposerHint("No model is selected. The model list must load first.");
		return;
	}

	const request = buildRequest(text);
	const run = createRun(provider, s, model, request);
	const conversation = conversationFor(provider.id);
	const userTurn = { role: "user", content: text, runId: run.id, excluded: false };
	const turn = {
		role: "assistant",
		content: "",
		reasoning: "",
		runId: run.id,
		state: "running",
		error: null,
		excluded: false,
		modelName: run.modelName,
	};
	conversation.turns.push(userTurn, turn);
	const active = { run, turn, userTurn, controller: new AbortController(), t0: performance.now() };
	state.active = active;
	state.runs.unshift(run);
	state.runs.length = Math.min(state.runs.length, HISTORY_LIMIT);
	state.selectedRunId = run.id;
	ui.composerInput.value = "";

	renderTranscript("end");
	renderComposerState();
	renderHistory();
	renderRunPanel();
	renderPreview();

	const outcome = await executeRun(active, request);
	run.status = outcome.status;
	run.error = outcome.error;
	turn.state = outcome.status;
	turn.error = outcome.error;
	if (outcome.status === "ok" && !turn.content.trim()) {
		turn.note = "The reply has no text, so this turn is not in the history.";
	}
	if (outcome.status !== "ok" || !turn.content.trim()) {
		// A failed turn stays visible, but the next request does not carry it.
		turn.excluded = true;
		userTurn.excluded = true;
		if (!ui.composerInput.value.trim()) ui.composerInput.value = userTurn.content;
	}
	const omp = ompInfo(run);
	if (omp.sessionId) conversation.lastSession = { id: omp.sessionId, source: omp.sessionSource };
	state.active = null;

	ui.announcer.textContent =
		outcome.status === "ok" ? "Reply complete." : outcome.status === "aborted" ? "Run aborted." : "Request failed.";
	renderTranscript("follow");
	renderComposerState();
	renderHistory();
	renderRunPanel();
	renderPreview();
	persistHistory();
	await pollRecord(run);
}

function abortActive() {
	state.active?.controller.abort();
}

async function pollRecord(run) {
	const requestId = ompInfo(run).requestId;
	if (!requestId) {
		run.serverState = "missing";
		refreshRunViews(run);
		return;
	}
	run.serverState = "polling";
	run.serverError = null;
	refreshRunViews(run);
	const deadline = performance.now() + POLL_TIMEOUT_MS;
	for (;;) {
		try {
			const res = await apiGet(`/api/requests/${encodeURIComponent(requestId)}`);
			const body = await readBody(res);
			if (!res.ok || !isRecord(body.json)) throw new Error(describeHttpError(res, body));
			run.record = body.json;
			if (body.json.status !== "pending") {
				run.serverState = "done";
				break;
			}
		} catch (err) {
			run.serverState = "error";
			run.serverError = errorText(err);
			break;
		}
		if (performance.now() >= deadline) {
			run.serverState = "timeout";
			break;
		}
		const { promise, resolve } = Promise.withResolvers();
		setTimeout(resolve, POLL_INTERVAL_MS);
		await promise;
	}
	refreshRunViews(run);
	persistHistory();
}

function refreshRunViews(run) {
	if (!state.runs.includes(run)) return;
	if (state.selectedRunId === run.id) renderRunPanel();
	renderHistory();
	renderTranscriptFoot(run);
}

// ── Rendering: chrome ────────────────────────────────────────────────────

function renderHealth() {
	const { status, version, error } = state.health;
	ui.healthDot.dataset.state = status;
	if (status === "ok") ui.healthText.textContent = `online${version ? ` · v${version}` : ""}`;
	else if (status === "error") ui.healthText.textContent = `offline · ${error}`;
	else ui.healthText.textContent = "Connecting…";
	ui.healthText.parentElement.title = status === "error" ? error : "";
}

function renderPills() {
	const pills = state.providers.map(p => {
		const selected = p.id === state.current;
		const noAccounts = p.listed && p.accounts.length === 0;
		return h(
			"button",
			{
				type: "button",
				class: "pill",
				role: "radio",
				"aria-checked": String(selected),
				tabindex: selected ? "0" : "-1",
				dataset: { id: p.id },
				title: noAccounts ? "No stored accounts" : null,
			},
			p.label,
			noAccounts ? h("span", { class: "pill__flag", "aria-hidden": "true" }) : null,
			noAccounts ? h("span", { class: "visually-hidden", text: " (no stored accounts)" }) : null,
		);
	});
	ui.pills.replaceChildren(...pills);
	ui.providersError.hidden = state.providersStatus !== "error";
	if (state.providersStatus === "error") {
		ui.providersError.replaceChildren(
			h("span", { class: "notice__title", text: "GET /api/providers failed" }),
			h("span", { class: "notice__body", text: `${state.providersError}\nThe tabs use the built-in order. Account lists are not available.` }),
		);
	}
}

function selectProvider(id, focusPill = false) {
	if (!state.providers.some(p => p.id === id) || id === state.current) return;
	state.current = id;
	persistSettings();
	renderPills();
	if (focusPill) ui.pills.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
	renderControls();
	renderTranscript("end");
	renderPreview();
	void loadModels(id);
}

function onPillKeydown(event) {
	const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
	if (!keys.includes(event.key)) return;
	event.preventDefault();
	const ids = state.providers.map(p => p.id);
	const index = ids.indexOf(state.current);
	let next = index;
	if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % ids.length;
	else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + ids.length) % ids.length;
	else if (event.key === "Home") next = 0;
	else next = ids.length - 1;
	selectProvider(ids[next], true);
}

// ── Rendering: controls ──────────────────────────────────────────────────

function renderControls() {
	const provider = currentProvider();
	const count = modelsFor(provider.id).status === "ok" ? modelsFor(provider.id).list.length : provider.modelCount;
	ui.providerMeta.textContent = count !== null ? `${count} model${count === 1 ? "" : "s"}` : "";
	ui.providerMeta.title = provider.id;
	renderModelField();
	renderAccountField();
	renderEffortField();
	renderFormatField();
	renderSessionField();
	renderAccountsInfo();
	renderComposerState();
}

function renderModelField() {
	const providerId = state.current;
	const entry = modelsFor(providerId);
	const s = settingsFor(providerId);
	ui.modelsRetry.hidden = entry.status !== "error";
	ui.modelHint.removeAttribute("data-tone");
	if (entry.status !== "ok" || entry.list.length === 0) {
		const text =
			entry.status === "error" ? "Models unavailable" : entry.status === "ok" ? "No models" : "Loading models…";
		ui.modelSelect.replaceChildren(h("option", { value: "", text }));
		ui.modelSelect.disabled = true;
		if (entry.status === "error") {
			ui.modelHint.dataset.tone = "error";
			ui.modelHint.textContent = entry.error;
		} else {
			ui.modelHint.textContent = entry.status === "ok" ? "The server lists no models for this provider." : "";
		}
		return;
	}
	ui.modelSelect.disabled = false;
	ui.modelSelect.replaceChildren(
		...entry.list.map(m => {
			const ctx = fmtCompact(m.context_length);
			const name = str(m.display_name) ?? bareModelId(providerId, m.id);
			return h("option", { value: m.id, title: m.id, text: ctx ? `${name} · ${ctx}` : name });
		}),
	);
	ui.modelSelect.value = s.model ?? "";
	const model = currentModel();
	if (!model) return;
	const parts = [bareModelId(providerId, model.id)];
	if (str(model.api)) parts.push(model.api);
	const ctx = fmtCompact(model.context_length);
	const out = fmtCompact(model.max_output_tokens);
	if (ctx) parts.push(`ctx ${ctx}`);
	if (out) parts.push(`out ${out}`);
	if (Array.isArray(model.input_modalities) && model.input_modalities.length > 0) parts.push(model.input_modalities.join("+"));
	if (model.reasoning) parts.push("reasoning");
	ui.modelHint.textContent = parts.join(" · ");
}

function accountName(acct) {
	return str(acct.label) ?? str(acct.email) ?? str(acct.identityKey) ?? `credential ${acct.credentialId}`;
}

function renderAccountField() {
	const provider = currentProvider();
	const s = settingsFor(provider.id);
	const routing = provider.routing;
	const options = [
		h("option", { value: "auto", text: routing ? `auto · routing rules (${routing.strategy})` : "auto · built-in selection" }),
		h("option", { value: "any", text: "any · usage-ranked" }),
	];
	for (const acct of provider.accounts) {
		const name = accountName(acct);
		const extra = str(acct.label) && str(acct.email) ? ` · ${acct.email}` : "";
		options.push(
			h("option", {
				value: String(acct.credentialId),
				disabled: acct.disabled === true,
				text: `${name}${extra} · #${acct.credentialId}${acct.disabled ? " (disabled)" : ""}`,
			}),
		);
	}
	// Keep a saved pin until the account list loads. Then drop it if it is gone.
	const pinned = s.account !== "auto" && s.account !== "any";
	if (pinned && state.providersStatus !== "ok" && !provider.accounts.some(a => String(a.credentialId) === s.account)) {
		options.push(h("option", { value: s.account, text: `#${s.account} (saved)` }));
	}
	ui.accountSelect.replaceChildren(...options);
	const valid = Array.from(ui.accountSelect.options).some(o => o.value === s.account && !o.disabled);
	if (!valid) s.account = "auto";
	ui.accountSelect.value = s.account;
	renderAccountHint();
}

function renderAccountHint() {
	const provider = currentProvider();
	const s = settingsFor(provider.id);
	const routing = provider.routing;
	if (s.account === "auto") {
		ui.accountHint.textContent = routing
			? `Routing rules from account-routing.yml: ${routing.strategy}${
					Array.isArray(routing.order) && routing.order.length > 0 ? `, order ${routing.order.join(" → ")}` : ""
				}.`
			: "No routing rules for this provider. pi-ai selects the credential.";
	} else if (s.account === "any") {
		ui.accountHint.textContent = "pi-ai usage-ranked selection. Routing rules are not used.";
	} else {
		const acct = provider.accounts.find(a => String(a.credentialId) === s.account);
		ui.accountHint.textContent = `Pinned to ${acct ? `${accountName(acct)} (#${s.account})` : `credential #${s.account}`}.`;
	}
}

function renderEffortField() {
	const s = settingsFor(state.current);
	const model = currentModel();
	if (!model) {
		// The model list is not loaded yet. Keep the saved effort.
		ui.effortSelect.replaceChildren(h("option", { value: s.effort, text: s.effort }));
		ui.effortSelect.disabled = true;
		ui.effortHint.hidden = true;
		return;
	}
	const thinking = model.reasoning && isRecord(model.thinking) ? model.thinking : null;
	const levels = Array.isArray(thinking?.levels) ? thinking.levels.filter(l => typeof l === "string") : [];
	if (s.effort !== "default" && !levels.includes(s.effort)) s.effort = "default";
	const defaultText = !model.reasoning
		? "default (no reasoning)"
		: str(thinking?.default)
			? `default (omp: ${thinking.default})`
			: "default (provider decides)";
	ui.effortSelect.replaceChildren(
		h("option", { value: "default", text: defaultText }),
		...levels.map(level => h("option", { value: level, text: level })),
	);
	ui.effortSelect.value = s.effort;
	ui.effortSelect.disabled = levels.length === 0;
	ui.effortHint.hidden = !levels.includes("off");
	ui.effortHint.textContent = levels.includes("off")
		? "auto: omp's judge picks the level each user turn. off: where the model cannot turn reasoning off, omp runs its fallback level."
		: "";
}

function setRadio(group, value) {
	for (const input of group.querySelectorAll("input[type=radio]")) input.checked = input.value === value;
}

function renderFormatField() {
	const s = settingsFor(state.current);
	setRadio(ui.formatGroup, s.format);
	ui.stream.checked = s.stream;
	ui.maxTokens.value = s.maxTokens;
	ui.temperature.value = s.temperature;
	const model = currentModel();
	const modelMax = num(model?.max_output_tokens);
	ui.maxTokens.placeholder = s.format === "messages" ? `${modelMax ?? FALLBACK_MAX_TOKENS} (required)` : "model max";
	ui.formatHint.textContent = `POST /v1/${state.current}/${FORMAT_PATHS[s.format]}`;
}

function renderSessionField() {
	const s = settingsFor(state.current);
	setRadio(ui.sessionModeGroup, s.sessionMode);
	ui.sessionFixed.hidden = s.sessionMode !== "fixed";
	ui.sessionId.value = s.sessionId;
	ui.sessionHint.removeAttribute("data-tone");
	if (s.sessionMode === "fixed" && !s.sessionId.trim()) {
		ui.sessionHint.dataset.tone = "warn";
		ui.sessionHint.textContent = "No id. The server uses the history chain until you type one.";
	} else if (s.sessionMode === "fixed") {
		ui.sessionHint.textContent = "Sent as ?session= on each turn.";
	} else {
		ui.sessionHint.textContent = "The server finds the session from the history chain. Each send carries the full history.";
	}
}

function renderAccountsInfo() {
	const provider = currentProvider();
	if (state.providersStatus === "loading") {
		ui.accountList.replaceChildren(h("li", { class: "hint", text: "Loading…" }));
		ui.routingInfo.textContent = "";
		return;
	}
	if (!provider.listed) {
		ui.accountList.replaceChildren(h("li", { class: "hint", text: "Account list unavailable." }));
		ui.routingInfo.textContent = "";
		return;
	}
	if (provider.accounts.length === 0) {
		ui.accountList.replaceChildren(
			h("li", { class: "hint", text: "No stored accounts. Log in to this provider with omp, then reload." }),
		);
	} else {
		ui.accountList.replaceChildren(
			...provider.accounts.map(acct =>
				h(
					"li",
					{ class: "account", dataset: { disabled: String(acct.disabled === true) }, title: acct.disabled ? "Disabled" : null },
					h("span", { class: "account__name", text: accountName(acct) }),
					h("span", { class: "account__id", text: `#${acct.credentialId}${acct.disabled ? " · off" : ""}` }),
				),
			),
		);
	}
	const routing = provider.routing;
	ui.routingInfo.textContent = routing
		? `Routing: ${routing.strategy}${Array.isArray(routing.order) && routing.order.length > 0 ? ` · ${routing.order.join(" → ")}` : ""}`
		: "Routing: none configured";
}

function renderComposerState() {
	const running = state.active !== null;
	const model = currentModel();
	ui.send.disabled = running || !model;
	ui.abort.hidden = !running;
	ui.clearConversation.disabled = running;
	ui.newConversation.disabled = running;
	const provider = currentProvider();
	ui.composerInput.placeholder = model
		? `Message ${provider.label} · ${str(model.display_name) ?? bareModelId(provider.id, model.id)}`
		: "Message";
}

function flashComposerHint(text) {
	ui.composerHint.dataset.tone = "warn";
	ui.composerHint.textContent = text;
	clearTimeout(hintTimer);
	hintTimer = setTimeout(() => {
		ui.composerHint.removeAttribute("data-tone");
		ui.composerHint.replaceChildren(...defaultComposerHint.map(n => n.cloneNode(true)));
	}, HINT_MS);
}

// ── Rendering: transcript ────────────────────────────────────────────────

function renderTranscriptChrome() {
	const conversation = conversationFor(state.current);
	const inHistory = conversation.turns.filter(t => !t.excluded && t.state !== "running").length;
	const parts = [`${inHistory} message${inHistory === 1 ? "" : "s"} in history`];
	if (conversation.lastSession) {
		parts.push(`session ${shortId(conversation.lastSession.id)}${conversation.lastSession.source ? ` (${conversation.lastSession.source})` : ""}`);
	}
	ui.conversationMeta.textContent = parts.join(" · ");
	ui.conversationMeta.title = conversation.lastSession?.id ?? "";
	renderComposerState();
}

// scroll: "end" jumps to the last turn, "follow" stays at the end only if the view is there, "keep" holds the position.
function renderTranscript(scroll = "keep") {
	const conversation = conversationFor(state.current);
	renderTranscriptChrome();
	const box = ui.transcript;
	const previousTop = box.scrollTop;
	const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END_PX;
	if (conversation.turns.length === 0) {
		ui.transcript.replaceChildren(
			h(
				"li",
				{ class: "empty" },
				h("p", { class: "empty__title", text: "Start a conversation" }),
				h("p", {
					text: "Select a model, type a message, and send. Each reply goes into the history, so the next send carries the full conversation. This lets the server chain the session.",
				}),
				h("p", { text: "Metrics for each run show in the Run panel. Every run also goes into the run history." }),
			),
		);
		return;
	}
	box.replaceChildren(...conversation.turns.map(renderTurn));
	box.scrollTop = scroll === "end" || (scroll === "follow" && atEnd) ? box.scrollHeight : previousTop;
}

function renderTurn(turn) {
	if (turn.role === "user") {
		return h(
			"li",
			{ class: "turn turn--user", dataset: { excluded: String(turn.excluded) } },
			h(
				"div",
				{ class: "turn__head" },
				turn.excluded ? h("span", { class: "badge", text: "not in history" }) : null,
				h("span", { class: "turn__role", text: "You" }),
			),
			h("div", { class: "turn__text", text: turn.content }),
		);
	}
	const badge = h("span", { class: "badge" });
	const reasoningSummary = h("summary");
	const reasoningText = h("div", { class: "reasoning__text" });
	const reasoning = h(
		"details",
		{ class: "reasoning", open: turn.reasoningOpen === true },
		reasoningSummary,
		reasoningText,
	);
	reasoning.addEventListener("toggle", () => {
		turn.reasoningOpen = reasoning.open;
	});
	const placeholder = h("p", { class: "turn__placeholder" });
	const text = h("div", { class: "turn__text" });
	const notice = h("div", { class: "notice" });
	const foot = h("div", { class: "turn__foot" });
	const root = h(
		"li",
		{ class: "turn turn--assistant" },
		h("div", { class: "turn__head" }, h("span", { class: "turn__role", text: turn.modelName }), badge),
		reasoning,
		placeholder,
		text,
		notice,
		foot,
	);
	turnElements.set(turn, { root, badge, reasoning, reasoningSummary, reasoningText, placeholder, text, notice, foot });
	updateTurnElement(turn);
	return root;
}

function updateTurnElement(turn) {
	const refs = turnElements.get(turn);
	if (!refs) return;
	const running = turn.state === "running";
	refs.root.dataset.state = turn.state;
	refs.root.dataset.excluded = String(turn.excluded);
	const run = findRun(turn.runId);
	const waiting = running && (!run || run.response.status === null);
	refs.badge.dataset.tone = statusTone(turn.state) ?? "";
	const liveLabel = waiting ? "waiting" : run?.stream ? "streaming" : "receiving";
	refs.badge.textContent = running ? liveLabel : turn.excluded ? `${turn.state} · not in history` : turn.state;
	refs.reasoning.hidden = turn.reasoning.length === 0;
	refs.reasoningSummary.textContent = `Reasoning · ${fmtInt(turn.reasoning.length)} chars${running && !turn.content ? " · live" : ""}`;
	if (refs.reasoningText.textContent.length !== turn.reasoning.length) refs.reasoningText.textContent = turn.reasoning;
	refs.placeholder.hidden = !(running && !turn.content && !turn.reasoning);
	refs.placeholder.textContent = waiting ? "Waiting for response headers…" : "Waiting for the first token…";
	if (refs.text.textContent.length !== turn.content.length) refs.text.textContent = turn.content;
	const message = turn.error ?? turn.note ?? null;
	refs.notice.hidden = !message;
	if (message) {
		const failed = turn.state === "error";
		refs.notice.className = `notice ${failed ? "notice--error" : "notice--warn"}`;
		refs.notice.replaceChildren(
			h("span", { class: "notice__title", text: turn.state === "aborted" ? "Aborted" : failed ? "Request failed" : "Note" }),
			h("span", { class: "notice__body", text: message }),
		);
	}
	renderTurnFoot(turn, refs.foot);
}

function renderTurnFoot(turn, foot) {
	const run = findRun(turn.runId);
	if (!run || turn.state === "running") {
		foot.replaceChildren();
		return;
	}
	const omp = ompInfo(run);
	const usage = usageOf(run).usage;
	const items = [
		h("span", { text: `TTFT ${fmtMs(run.client.ttftMs)}` }),
		h("span", { text: `total ${fmtMs(run.client.totalMs)}` }),
	];
	if (usage) items.push(h("span", { text: `${fmtInt(usage.output)} out tok` }));
	const cost = costOf(run);
	if (cost !== null) items.push(h("span", { text: fmtUsd(cost) }));
	if (omp.sessionSource) items.push(h("span", { class: "badge", dataset: { tone: sessionTone(omp.sessionSource) ?? "" }, text: `session ${omp.sessionSource}` }));
	if (omp.thinking) items.push(h("span", { class: "badge", text: `thinking ${omp.thinking}${omp.thinkingSource ? ` (${omp.thinkingSource})` : ""}` }));
	items.push(
		h("button", {
			type: "button",
			class: "btn btn--link",
			text: "Inspect",
			onclick: () => {
				selectRun(run.id);
				ui.runPanel.focus();
			},
		}),
	);
	foot.replaceChildren(...items);
}

function renderTranscriptFoot(run) {
	for (const turn of conversationFor(run.provider).turns) {
		if (turn.runId === run.id && turn.role === "assistant") {
			const refs = turnElements.get(turn);
			if (refs?.root.isConnected) renderTurnFoot(turn, refs.foot);
		}
	}
}

function schedulePaint() {
	if (paintQueued) return;
	paintQueued = true;
	requestAnimationFrame(() => {
		paintQueued = false;
		paintActive();
	});
}

function paintActive() {
	const active = state.active;
	if (!active) return;
	const box = ui.transcript;
	const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END_PX;
	updateTurnElement(active.turn);
	if (nearEnd) box.scrollTop = box.scrollHeight;
	if (state.selectedRunId === active.run.id) scheduleInspectorPaint();
}

// Repaint the inspector at a bounded rate while a run streams. A trailing timer paints the last delta.
function scheduleInspectorPaint() {
	const wait = state.runTab === "metrics" ? METRICS_REPAINT_MS : INSPECTOR_REPAINT_MS;
	const due = lastInspectorPaint + wait - performance.now();
	if (due <= 0) {
		renderRunPanel();
		return;
	}
	if (inspectorTimer) return;
	inspectorTimer = setTimeout(() => {
		inspectorTimer = 0;
		renderRunPanel();
	}, due);
}

// ── Rendering: run inspector ─────────────────────────────────────────────

function selectRun(id) {
	state.selectedRunId = id;
	renderRunPanel();
	// Update the row marks in place, so keyboard focus stays on the row button.
	for (const row of ui.historyBody.querySelectorAll("tr[data-id]")) {
		if (row.dataset.id === id) row.setAttribute("aria-current", "true");
		else row.removeAttribute("aria-current");
	}
}

function selectRunTab(tab, focus = false) {
	state.runTab = tab;
	renderRunPanel();
	if (focus) ui.runTabs.querySelector(`[data-tab="${tab}"]`)?.focus();
}

function onRunTabKeydown(event) {
	if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
	event.preventDefault();
	const tabs = Array.from(ui.runTabs.querySelectorAll("[role=tab]")).map(t => t.dataset.tab);
	const index = tabs.indexOf(state.runTab);
	const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
	selectRunTab(tabs[next], true);
}

function renderRunPanel() {
	lastInspectorPaint = performance.now();
	const panelKey = `${state.selectedRunId}:${state.runTab}`;
	const keepScroll = panelKey === lastPanelKey;
	lastPanelKey = panelKey;
	for (const tab of ui.runTabs.querySelectorAll("[role=tab]")) {
		const selected = tab.dataset.tab === state.runTab;
		tab.setAttribute("aria-selected", String(selected));
		tab.tabIndex = selected ? 0 : -1;
		if (selected) ui.runPanel.setAttribute("aria-labelledby", tab.id);
	}
	const run = findRun(state.selectedRunId);
	ui.copyRunTab.hidden = !run || state.runTab === "metrics";
	if (!run) {
		ui.runMeta.textContent = "";
		ui.runPanel.replaceChildren(
			h("p", {
				class: "run-empty",
				text: "No run selected. Send a message, or select a row in the run history. The panel shows metrics, the raw request, the raw response, headers, and the server record.",
			}),
		);
		return;
	}
	ui.runMeta.textContent = `${run.providerLabel} · ${run.model} · ${fmtClock(run.startedAt)}`;
	ui.runMeta.title = ui.runMeta.textContent;
	const scrollTop = keepScroll ? ui.runPanel.scrollTop : 0;
	const view = { metrics: renderMetricsTab, request: renderRequestTab, response: renderResponseTab, headers: renderHeadersTab, record: renderRecordTab }[state.runTab];
	ui.runPanel.replaceChildren(...view(run));
	ui.runPanel.scrollTop = scrollTop;
}

function readoutCell(label, value, title) {
	const empty = value === "—";
	return h(
		"div",
		{ class: "readout__cell", title },
		h("span", { class: "label", text: label }),
		h("span", { class: "readout__value", dataset: { empty: String(empty) }, text: value }),
	);
}

function kvList(rows, emptyText = "Not reported.") {
	const dl = h("dl", { class: "kv" });
	for (const [key, value] of rows) {
		if (value === null || value === undefined || value === "") continue;
		dl.append(h("dt", { text: key }), h("dd", {}, value));
	}
	return dl.childElementCount > 0 ? dl : h("p", { class: "section__note", text: emptyText });
}

function section(label, note, ...children) {
	return h(
		"section",
		{ class: "section" },
		h("div", { class: "section__head" }, h("h3", { class: "label", text: label }), note ? h("span", { class: "section__note" }, note) : null),
		...children,
	);
}

function sessionNode(id, source) {
	if (!id && !source) return null;
	return h(
		"span",
		{},
		id ? `${id} ` : "",
		source ? h("span", { class: "badge", dataset: { tone: sessionTone(source) ?? "" }, text: source }) : null,
	);
}

function renderMetricsTab(run) {
	const omp = ompInfo(run);
	const record = isRecord(run.record) ? run.record : null;
	const nodes = [];

	nodes.push(
		h(
			"div",
			{ class: "summary-line" },
			h("span", { class: "badge", dataset: { tone: statusTone(run.status) ?? "" }, text: run.status }),
			h("span", { text: FORMAT_PATHS[run.format] }),
			h("span", { text: run.stream ? "stream" : "non-stream" }),
			run.response.status !== null ? h("span", { text: `HTTP ${run.response.status}` }) : null,
		),
	);
	if (run.error) {
		nodes.push(
			h(
				"div",
				{ class: `notice ${run.status === "aborted" ? "notice--warn" : "notice--error"}` },
				h("span", { class: "notice__title", text: run.status === "aborted" ? "Aborted" : "Error" }),
				h("span", { class: "notice__body", text: run.error }),
			),
		);
	}

	nodes.push(
		section(
			"Client",
			"measured in this browser",
			h(
				"div",
				{ class: "readout" },
				readoutCell("TTFB", fmtMs(run.client.ttfbMs), "Time to response headers"),
				readoutCell("TTFT", fmtMs(run.client.ttftMs), "Time to the first text or reasoning token"),
				readoutCell("Total", fmtMs(run.client.totalMs), "Time to the end of the body"),
				readoutCell("Chars/s", fmtRate(charsPerSecond(run)), "Text and reasoning characters per second after the first token"),
			),
		),
	);

	nodes.push(
		section(
			"Proxy",
			"x-omp-* response headers",
			run.response.status === null
				? h("p", { class: "section__note", text: run.status === "running" ? "Waiting for headers…" : "No response headers." })
				: kvList([
						["Request id", omp.requestId],
						["Session", sessionNode(str(run.response.headers["x-omp-session-id"]), str(run.response.headers["x-omp-session-source"]))],
						["Account", omp.account],
						["Credential id", omp.credentialId],
						["Provider", omp.provider],
						["Model", omp.model],
						["Proxy overhead", omp.overheadMs !== null ? fmtMs(omp.overheadMs) : null],
						["Thinking", omp.thinking ? `${omp.thinking}${omp.thinkingSource ? ` (${omp.thinkingSource})` : ""}` : null],
						["Gateway cost", omp.cost !== null ? fmtUsd(omp.cost) : null],
						["Gateway duration", omp.durationMs !== null ? fmtMs(omp.durationMs) : null],
					], "No x-omp-* headers in this response."),
		),
	);

	const stateText = run.serverState === "error" ? `${SERVER_STATE_TEXT.error} ${run.serverError ?? ""}` : SERVER_STATE_TEXT[run.serverState];
	const canRefetch = ["timeout", "error", "interrupted"].includes(run.serverState) && omp.requestId;
	const serverNote = h(
		"span",
		{},
		record?.status === "pending" && run.serverState === "polling" ? "pending…" : stateText,
		canRefetch ? " " : null,
		canRefetch ? h("button", { type: "button", class: "btn btn--link", text: "Fetch again", onclick: () => void pollRecord(run) }) : null,
	);
	const timings = isRecord(record?.timings) ? record.timings : {};
	const { usage, source } = usageOf(run);
	const ratio = cacheHitRatio(usage);
	const serverChildren = [
		h(
			"div",
			{ class: "readout" },
			readoutCell("Upstream TTFT", fmtMs(timings.upstreamTtftMs), "pi-ai message.ttft"),
			readoutCell("Upstream", fmtMs(timings.upstreamDurationMs), "pi-ai message.duration"),
			readoutCell("Out tok/s", fmtRate(record?.outputTokensPerSec), "Output tokens per second from the server record"),
			readoutCell("Cost", fmtUsd(costOf(run)), "USD from the pi-ai catalog"),
		),
	];
	nodes.push(section("Server", serverNote, ...serverChildren));

	const usageChildren = usage
		? [
				h(
					"div",
					{ class: "readout readout--6" },
					readoutCell("Input", fmtInt(usage.input), "Input tokens without cache"),
					readoutCell("Cache read", fmtInt(usage.cacheRead)),
					readoutCell("Cache write", fmtInt(usage.cacheWrite)),
					readoutCell("Output", fmtInt(usage.output)),
					readoutCell("Reasoning", fmtInt(usage.reasoningTokens)),
					readoutCell("Total", fmtInt(usage.totalTokens)),
				),
				h(
					"div",
					{ class: "meter", role: "img", "aria-label": `Cache hit ${fmtPct(ratio)}` },
					h("div", { class: "meter__fill", style: `width: ${Math.round((ratio ?? 0) * 100)}%` }),
				),
				h("div", { class: "meter-label" }, h("span", { text: "cache hit = cacheRead / (input + cacheRead + cacheWrite)" }), h("span", { text: fmtPct(ratio) })),
			]
		: [h("p", { class: "section__note", text: run.status === "running" ? "Usage arrives at the end of the turn." : "No usage reported." })];
	nodes.push(section("Usage", source === "wire" ? "from the wire (no server record)" : source === "server" ? "from the server record" : null, ...usageChildren));

	if (record) {
		const cost = isRecord(record.cost) ? record.cost : null;
		const account = isRecord(record.account) ? record.account : null;
		const session = isRecord(record.session) ? record.session : null;
		nodes.push(
			section(
				"Record",
				null,
				kvList([
					["Status", `${record.status}${record.httpStatus !== null && record.httpStatus !== undefined ? ` · HTTP ${record.httpStatus}` : ""}`],
					["Stop reason", str(record.stopReason) ?? str(run.wire.stopReason)],
					["Error", str(record.error)],
					["API", str(record.api)],
					["Upstream", str(record.upstreamBaseUrl)],
					["Response id", str(record.responseId)],
					["Session", session ? sessionNode(str(session.id), str(session.source)) : null],
					["Account", account ? `${account.label ?? account.email ?? "—"} · #${account.credentialId}` : null],
					["Proxy overhead", num(timings.proxyOverheadMs) !== null ? fmtMs(timings.proxyOverheadMs) : null],
					["Server total", num(timings.totalMs) !== null ? fmtMs(timings.totalMs) : null],
					[
						"Cost split",
						cost
							? `in ${fmtUsd(cost.input)} · out ${fmtUsd(cost.output)} · cache r ${fmtUsd(cost.cacheRead)} · w ${fmtUsd(cost.cacheWrite)}`
							: null,
					],
				]),
			),
		);
	} else if (run.wire.stopReason) {
		nodes.push(section("Wire", null, kvList([["Stop reason", run.wire.stopReason]])));
	}
	return nodes;
}

function responseTabText(run) {
	const r = run.response;
	if (r.kind === "sse") {
		return r.events.map(ev => `${ev.event ? `event: ${ev.event}\n` : ""}data: ${ev.data}\n\n`).join("");
	}
	if (r.kind === "body") return prettyText(r.body);
	return "";
}

function headersTabText(run) {
	const r = run.response;
	const lines = [];
	if (r.status !== null) {
		lines.push(`HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`);
		for (const [key, value] of sortedHeaders(r.headers)) lines.push(`${key}: ${value}`);
	}
	lines.push("", "Request headers");
	for (const [key, value] of Object.entries(run.request.headers)) lines.push(`${key}: ${value}`);
	return lines.join("\n");
}

function sortedHeaders(headers) {
	return Object.entries(headers).sort(([a], [b]) => {
		const ao = a.startsWith("x-omp-") ? 0 : 1;
		const bo = b.startsWith("x-omp-") ? 0 : 1;
		return ao - bo || a.localeCompare(b);
	});
}

function renderRequestTab(run) {
	return [h("pre", { class: "code", text: requestText(run.request) })];
}

function renderResponseTab(run) {
	const r = run.response;
	const nodes = [];
	if (r.truncated) nodes.push(h("p", { class: "section__note", text: "Stored copy. The response is cut to save browser storage." }));
	if (r.kind === "sse") {
		const log = h("div", { class: "code sse-log" });
		for (const ev of r.events) {
			log.append(
				h(
					"div",
					{ class: "sse-event" },
					h("div", { class: "sse-event__head" }, h("span", { class: "code__dim", text: `+${ev.t} ms` }), h("span", { class: "code__event", text: ev.event ?? "data" })),
					h("div", { class: "sse-event__data", text: ev.data }),
				),
			);
		}
		if (r.events.length === 0) log.textContent = run.status === "running" ? "Waiting for events…" : "No events.";
		nodes.push(h("p", { class: "section__note", text: `${r.events.length} SSE events · times from fetch start · Copy gives the raw stream` }), log);
	} else if (r.kind === "body") {
		nodes.push(h("pre", { class: "code", text: prettyText(r.body) || "(empty body)" }));
	} else {
		nodes.push(h("p", { class: "section__note", text: run.status === "running" ? "Waiting for the response…" : "No response." }));
	}
	return nodes;
}

function renderHeadersTab(run) {
	const r = run.response;
	const nodes = [];
	if (r.status === null) {
		nodes.push(h("p", { class: "section__note", text: run.status === "running" ? "Waiting for headers…" : "No response headers." }));
	} else {
		const pre = h("pre", { class: "code" }, h("span", { class: "code__key", text: `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}\n` }));
		for (const [key, value] of sortedHeaders(r.headers)) {
			pre.append(h("span", { class: key.startsWith("x-omp-") ? "code__event" : "code__dim", text: `${key}: ` }), `${value}\n`);
		}
		nodes.push(pre);
	}
	nodes.push(
		h("div", { class: "section__head" }, h("h3", { class: "label", text: "Request headers" })),
		h("pre", { class: "code", text: Object.entries(run.request.headers).map(([k, v]) => `${k}: ${v}`).join("\n") }),
	);
	return nodes;
}

function renderRecordTab(run) {
	const nodes = [];
	const stateText = run.serverState === "error" ? `${SERVER_STATE_TEXT.error} ${run.serverError ?? ""}` : SERVER_STATE_TEXT[run.serverState];
	const requestId = ompInfo(run).requestId;
	nodes.push(h("p", { class: "section__note", text: requestId ? `GET /api/requests/${requestId} · ${stateText}` : stateText }));
	if (run.record) nodes.push(h("pre", { class: "code", text: prettyJson(run.record) }));
	return nodes;
}

async function copyRunTab() {
	const run = findRun(state.selectedRunId);
	if (!run) return;
	const textByTab = {
		request: () => requestText(run.request),
		response: () => responseTabText(run),
		headers: () => headersTabText(run),
		record: () => (run.record ? prettyJson(run.record) : ""),
	};
	const text = textByTab[state.runTab]?.() ?? "";
	await copyWithToast(text, `${state.runTab} copied`);
}

// ── Rendering: preview and history ───────────────────────────────────────

function renderPreview() {
	const draft = ui.composerInput.value;
	const request = buildRequest(draft.trim() ? draft : "");
	const shown = { ...request, headers: redactedHeaders(request.headers) };
	ui.previewCode.textContent = requestText(shown);
	const notes = [];
	if (!draft.trim()) notes.push("composer empty");
	if (!currentModel()) notes.push("no model");
	ui.previewMeta.textContent = notes.join(" · ");
}

function renderHistory() {
	const count = state.runs.length;
	ui.historyMeta.textContent = count ? `${count} of ${HISTORY_LIMIT} kept in this browser` : "";
	ui.clearHistory.disabled = count === 0 || state.active !== null;
	if (count === 0) {
		ui.historyBody.replaceChildren(
			h(
				"tr",
				{ class: "table-empty" },
				h("td", { colspan: "12", text: "No runs yet. Each send adds a row here. Select a row to inspect its request, response, headers, and server record." }),
			),
		);
		return;
	}
	ui.historyBody.replaceChildren(...state.runs.map(historyRow));
}

function historyRow(run) {
	const omp = ompInfo(run);
	const { usage } = usageOf(run);
	const selected = run.id === state.selectedRunId;
	return h(
		"tr",
		{ dataset: { id: run.id }, "aria-current": selected ? "true" : null },
		h("td", {}, h("button", { type: "button", class: "row-link", text: fmtClock(run.startedAt), "aria-label": `Inspect run at ${fmtClock(run.startedAt)}, ${run.providerLabel} ${run.model}` })),
		h("td", { text: run.providerLabel }),
		h("td", { class: "cell-model", title: run.model, text: run.model }),
		h("td", { text: accountText(run) }),
		h("td", {}, omp.sessionSource ? h("span", { class: "badge", dataset: { tone: sessionTone(omp.sessionSource) ?? "" }, title: omp.sessionId ?? "", text: omp.sessionSource }) : "—"),
		h("td", { class: "num", text: fmtMs(run.client.ttftMs) }),
		h("td", { class: "num", text: fmtMs(run.client.totalMs) }),
		h("td", { class: "num", text: fmtInt(usage?.input) }),
		h("td", { class: "num", text: fmtInt(usage?.cacheRead) }),
		h("td", { class: "num", text: fmtInt(usage?.output) }),
		h("td", { class: "num", text: fmtUsd(costOf(run)) }),
		h("td", {}, h("span", { class: "badge", dataset: { tone: statusTone(run.status) ?? "" }, title: run.error ?? "", text: run.status })),
	);
}

// ── Clipboard, toast, announcer ──────────────────────────────────────────

async function copyText(text) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall back to the selection copy below.
	}
	const area = h("textarea", { class: "visually-hidden", readonly: true, "aria-hidden": "true" });
	area.value = text;
	document.body.append(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	area.remove();
	return ok;
}

async function copyWithToast(text, label) {
	const ok = await copyText(text);
	showToast(ok ? label : "Copy failed. The browser blocked the clipboard.");
}

function showToast(text) {
	ui.toast.textContent = text;
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		ui.toast.hidden = true;
	}, TOAST_MS);
}

// ── Events ───────────────────────────────────────────────────────────────

function bindElements() {
	const ids = {
		healthDot: "health-dot",
		healthText: "health-text",
		token: "token-input",
		pills: "provider-pills",
		providersError: "providers-error",
		providerMeta: "provider-meta",
		modelSelect: "model-select",
		modelsRetry: "models-retry",
		modelHint: "model-hint",
		accountSelect: "account-select",
		accountHint: "account-hint",
		effortSelect: "effort-select",
		effortHint: "effort-hint",
		formatGroup: "format-group",
		formatHint: "format-hint",
		maxTokens: "max-tokens",
		temperature: "temperature",
		stream: "stream-toggle",
		sessionModeGroup: "session-mode-group",
		sessionFixed: "session-fixed",
		sessionId: "session-id",
		sessionHint: "session-hint",
		newConversation: "new-conversation",
		accountList: "account-list",
		routingInfo: "routing-info",
		conversationMeta: "conversation-meta",
		clearConversation: "clear-conversation",
		systemPrompt: "system-prompt",
		transcript: "transcript",
		composer: "composer",
		composerInput: "composer-input",
		composerHint: "composer-hint",
		abort: "abort-button",
		send: "send-button",
		runMeta: "run-meta",
		copyRunTab: "copy-run-tab",
		runTabs: "run-tabs",
		runPanel: "run-panel",
		previewMeta: "preview-meta",
		previewCode: "preview-code",
		copyCurl: "copy-curl",
		historyMeta: "history-meta",
		clearHistory: "clear-history",
		historyBody: "history-body",
		announcer: "announcer",
		toast: "toast",
	};
	for (const [key, id] of Object.entries(ids)) ui[key] = document.getElementById(id);
	defaultComposerHint = Array.from(ui.composerHint.childNodes, n => n.cloneNode(true));
}

function updateSetting(key, value) {
	settingsFor(state.current)[key] = value;
	persistSettings();
	renderPreview();
}

function bindEvents() {
	ui.token.value = state.token;
	ui.token.addEventListener("input", () => {
		state.token = ui.token.value;
		writeStorage(STORAGE_KEYS.token, state.token.trim() ? state.token : null);
		renderPreview();
	});
	ui.token.addEventListener("change", () => {
		void loadHealth();
		void loadProviders();
		void loadModels(state.current, modelsFor(state.current).status === "error");
	});

	ui.pills.addEventListener("click", event => {
		const pill = event.target.closest(".pill");
		if (pill) selectProvider(pill.dataset.id, true);
	});
	ui.pills.addEventListener("keydown", onPillKeydown);

	ui.modelsRetry.addEventListener("click", () => void loadModels(state.current, true));
	ui.modelSelect.addEventListener("change", () => {
		updateSetting("model", ui.modelSelect.value);
		renderModelField();
		renderEffortField();
		renderFormatField();
		renderComposerState();
		renderPreview();
	});
	ui.accountSelect.addEventListener("change", () => {
		updateSetting("account", ui.accountSelect.value);
		renderAccountHint();
	});
	ui.effortSelect.addEventListener("change", () => updateSetting("effort", ui.effortSelect.value));
	ui.formatGroup.addEventListener("change", event => {
		updateSetting("format", event.target.value);
		renderEffortField();
		renderFormatField();
		renderPreview();
	});
	ui.stream.addEventListener("change", () => updateSetting("stream", ui.stream.checked));
	ui.maxTokens.addEventListener("input", () => updateSetting("maxTokens", ui.maxTokens.value));
	ui.temperature.addEventListener("input", () => updateSetting("temperature", ui.temperature.value));
	ui.sessionModeGroup.addEventListener("change", event => {
		const s = settingsFor(state.current);
		s.sessionMode = event.target.value;
		if (s.sessionMode === "fixed" && !s.sessionId.trim()) s.sessionId = newSessionId();
		persistSettings();
		renderSessionField();
		renderPreview();
	});
	ui.sessionId.addEventListener("input", () => {
		updateSetting("sessionId", ui.sessionId.value);
		renderSessionField();
	});
	ui.newConversation.addEventListener("click", () => {
		const s = settingsFor(state.current);
		if (s.sessionMode === "fixed") {
			s.sessionId = newSessionId();
			persistSettings();
			renderSessionField();
		}
		resetConversation();
		showToast(s.sessionMode === "fixed" ? "New conversation with a new session id" : "New conversation");
		ui.composerInput.focus();
	});
	ui.clearConversation.addEventListener("click", () => {
		resetConversation();
		ui.composerInput.focus();
	});

	ui.systemPrompt.value = state.systemPrompt;
	ui.systemPrompt.addEventListener("input", () => {
		state.systemPrompt = ui.systemPrompt.value;
		persistSettings();
		renderPreview();
	});

	ui.composer.addEventListener("submit", event => {
		event.preventDefault();
		void send();
	});
	ui.composerInput.addEventListener("keydown", event => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void send();
		} else if (event.key === "Escape" && state.active) {
			event.preventDefault();
			abortActive();
		}
	});
	ui.composerInput.addEventListener("input", renderPreview);
	ui.abort.addEventListener("click", abortActive);

	ui.runTabs.addEventListener("click", event => {
		const tab = event.target.closest("[role=tab]");
		if (tab) selectRunTab(tab.dataset.tab);
	});
	ui.runTabs.addEventListener("keydown", onRunTabKeydown);
	ui.copyRunTab.addEventListener("click", () => void copyRunTab());

	ui.copyCurl.addEventListener("click", () => {
		const draft = ui.composerInput.value;
		const command = curlCommand(buildRequest(draft.trim() ? draft : ""));
		const label = state.token.trim() ? "curl copied · token reads from $OMP_PROXY_TOKEN" : "curl command copied";
		void copyWithToast(command, label);
	});

	ui.historyBody.addEventListener("click", event => {
		const row = event.target.closest("tr[data-id]");
		if (row) selectRun(row.dataset.id);
	});
	ui.clearHistory.addEventListener("click", () => {
		state.runs = [];
		state.selectedRunId = null;
		writeStorage(STORAGE_KEYS.history, null);
		renderHistory();
		renderRunPanel();
		renderTranscript();
	});
}

function resetConversation() {
	const conversation = conversationFor(state.current);
	conversation.turns = [];
	conversation.lastSession = null;
	renderTranscript();
	renderPreview();
}

// ── Start ────────────────────────────────────────────────────────────────

function start() {
	bindElements();
	restoreState();
	bindEvents();
	renderHealth();
	renderPills();
	renderControls();
	renderTranscript();
	renderRunPanel();
	renderPreview();
	renderHistory();
	void loadHealth();
	void loadProviders().then(() => loadModels(state.current));
}

start();
