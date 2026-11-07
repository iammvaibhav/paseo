// Session-chain map: link a request with no client session to the session
// of the turn it continues. pi-ai sends the session id to upstreams as
// `x-opencode-session` / `prompt_cache_key` / `X-Claude-Code-Session-Id` /
// Codex session headers / Cursor `conversationId` / grok `x-grok-conv-id`.
import type { Context } from "@oh-my-pi/pi-ai";

const LRU_LIMIT = 100_000;
const TTL_MS = 24 * 60 * 60 * 1000;

interface ChainEntry {
	sessionId: string;
	createdAt: number;
	touchedAt: number;
}

// hash of h_{n} -> session id that owns it.
const chain = new Map<string, ChainEntry>();

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (typeof block !== "object" || block === null) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		// Images by identity: the URL, or a hash of the (already normalized) bytes.
		else if (block.type === "image" && typeof block.url === "string" && block.url.length > 0) {
			parts.push(`[image-url:${block.url}]`);
		} else if (block.type === "image" && typeof block.data === "string") {
			parts.push(`[image:${Bun.hash(block.data).toString(36)}]`);
		}
	}
	return parts.join("");
}

function canonicalMessage(role: string, content: unknown): string {
	if (role === "toolResult") {
		const blocks = Array.isArray(content) ? content : [];
		const texts: string[] = [];
		for (const block of blocks as Array<Record<string, unknown>>) {
			if (typeof block !== "object" || block === null) continue;
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
			else if (block.type === "image" && typeof block.data === "string") {
				texts.push(`image:${Bun.hash(block.data).toString(36)}`);
			}
		}
		const msg = content as { toolName?: unknown } | null;
		const name = typeof msg?.toolName === "string" ? msg.toolName : "";
		return canonicalJson({ role, name, text: texts.join("") });
	}
	if (role === "assistant" && Array.isArray(content)) {
		const texts: string[] = [];
		const calls: Array<{ name: string; args: string }> = [];
		for (const block of content as Array<Record<string, unknown>>) {
			if (typeof block !== "object" || block === null) continue;
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
			else if (block.type === "toolCall" && typeof block.name === "string") {
				calls.push({ name: block.name, args: canonicalJson(block.arguments ?? {}) });
			}
		}
		return canonicalJson({ role, text: texts.join(""), calls });
	}
	return canonicalJson({ role, text: textOf(content) });
}

export function chainHashes(provider: string, context: Context): string[] {
	const headParts: string[] = [provider];
	headParts.push((context.systemPrompt ?? []).join("\n\n"));
	headParts.push(
		(context.tools ?? [])
			.map(tool => canonicalJson({ name: tool.name, description: tool.description, parameters: tool.parameters }))
			.join("\n"),
	);
	let hash = Bun.hash(headParts.join("\0"));
	const hashes: string[] = [];
	for (const message of context.messages) {
		hash = Bun.hash(canonicalMessage(message.role, message.content), hash);
		hashes.push(hash.toString(36));
	}
	return hashes;
}

export function chainLookup(provider: string, context: Context): { sessionId: string; source: "chain" } | undefined {
	const hashes = chainHashes(provider, context);
	const now = Date.now();
	for (let i = hashes.length - 1; i >= 0; i--) {
		const entry = chain.get(hashes[i]);
		if (!entry) continue;
		if (now - entry.createdAt > TTL_MS) {
			chain.delete(hashes[i]);
			continue;
		}
		entry.touchedAt = now;
		chain.delete(hashes[i]);
		chain.set(hashes[i], entry);
		return { sessionId: entry.sessionId, source: "chain" };
	}
	return undefined;
}

export function chainStore(provider: string, context: Context, sessionId: string): void {
	const hashes = chainHashes(provider, context);
	if (hashes.length === 0) return;
	const now = Date.now();
	const last = hashes[hashes.length - 1];
	chain.delete(last);
	chain.set(last, { sessionId, createdAt: now, touchedAt: now });
	while (chain.size > LRU_LIMIT) {
		const oldest = chain.keys().next();
		if (oldest.done) break;
		chain.delete(oldest.value);
	}
}
