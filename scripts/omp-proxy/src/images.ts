// Image input, handled the way OMP handles a pasted image:
// - base64 images get OMP's paste normalization (`#normalizePastedImage` in
//   pi-coding-agent input-controller): `ensureSupportedImageInput`, then
//   `resizeImage` with its defaults (1568 px edge, ~500 KB, 200 px minimum).
// - http(s) image URLs pass through unchanged as `ImageContent.url`, which
//   pi-ai sends as a URL to providers whose API fetches remote images. They
//   are not resized. Providers that cannot take the URL get the bytes: the
//   proxy downloads the image and normalizes it like a base64 image.
//
// The wire-format parsers of pi-ai 18.4.3 lose URL images (chat and messages
// formats turn them into the text "[image: <url>]") and drop every image in
// Responses-format user messages. `restoreImages` puts them back.
import type { Context, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { ensureSupportedImageInput } from "@oh-my-pi/pi-tui/chat/image-loading";
import { isRecord } from "@oh-my-pi/pi-utils";

export type ImageFormat = "openai-chat" | "openai-responses" | "anthropic-messages";

/**
 * How each provider takes an image URL (tested against the live upstreams):
 * - "url": pi-ai sends the URL and the upstream downloads it.
 * - "url-with-type": Gemini (`fileData`) needs the MIME type with the URL, so
 *   pass it only when the URL's file extension gives the type.
 * Any other provider (Cursor: its transport has no URL field) gets the bytes.
 */
const URL_POLICY: Record<string, "url" | "url-with-type"> = {
	anthropic: "url",
	"openai-codex": "url",
	"opencode-go": "url",
	"grok-build": "url",
	"google-antigravity": "url-with-type",
};

const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const CACHE_LIMIT = 256;
const URL_CACHE_TTL_MS = 10 * 60 * 1000;

export class ImageInputError extends Error {}

type Part = TextContent | ImageContent;

// Each turn resends the whole history, so cache normalized images. The resize
// is deterministic, which keeps provider prompt-cache prefixes stable.
const normalizedCache = new Map<string, ImageContent>();
const downloadCache = new Map<string, { image: ImageContent; at: number }>();

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

function isHttpUrl(value: string): boolean {
	return value.startsWith("https://") || value.startsWith("http://");
}

function guessMimeType(url: string): string {
	const path = url.split(/[?#]/, 1)[0].toLowerCase();
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	if (path.endsWith(".gif")) return "image/gif";
	if (path.endsWith(".webp")) return "image/webp";
	return "application/octet-stream";
}

function urlImage(url: string): ImageContent {
	return { type: "image", data: "", mimeType: guessMimeType(url), url };
}

/** Collect the http(s) image URLs a client sent, for each wire format. */
function collectImageUrls(body: unknown, format: ImageFormat): Set<string> {
	const urls = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isRecord(value)) return;
		if (format === "openai-chat" && value.type === "image_url") {
			const ref = value.image_url;
			const url = typeof ref === "string" ? ref : isRecord(ref) ? ref.url : undefined;
			if (typeof url === "string" && isHttpUrl(url)) urls.add(url);
		}
		if (format === "anthropic-messages" && value.type === "image" && isRecord(value.source)) {
			const { type, url } = value.source;
			if (type === "url" && typeof url === "string" && isHttpUrl(url)) urls.add(url);
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(body);
	return urls;
}

function replacePlaceholders(parts: Part[], urls: Set<string>): Part[] {
	return parts.map(part => {
		if (part.type !== "text") return part;
		const match = /^\[image: (.+)\]$/.exec(part.text);
		return match && urls.has(match[1]) ? urlImage(match[1]) : part;
	});
}

/** Rebuild Responses-format user content from the client's original item. */
function responsesUserParts(item: unknown): Part[] | undefined {
	const content = isRecord(item) && Array.isArray(item.content) ? item.content.filter(isRecord) : undefined;
	if (!content?.some(block => block.type === "input_image")) return undefined;
	const parts: Part[] = [];
	for (const raw of content) {
		if ((raw.type === "input_text" || raw.type === "text") && typeof raw.text === "string") {
			parts.push({ type: "text", text: raw.text });
		} else if (raw.type === "input_image" && typeof raw.image_url === "string") {
			const decoded = decodeDataUri(raw.image_url);
			if (decoded) parts.push({ type: "image", data: decoded.data, mimeType: decoded.mimeType });
			else if (isHttpUrl(raw.image_url)) parts.push(urlImage(raw.image_url));
			else throw new ImageInputError(`Unsupported image_url: ${raw.image_url.slice(0, 80)}`);
		} else if (raw.type === "input_image") {
			throw new ImageInputError("input_image needs image_url (file_id is not supported)");
		}
	}
	return parts;
}

/** Put back the images that the pi-ai wire parsers lose. Mutates `context`. */
export function restoreImages(context: Context, body: unknown, format: ImageFormat): void {
	const urls = format === "openai-responses" ? new Set<string>() : collectImageUrls(body, format);
	for (const message of context.messages) {
		if (message.role === "user" || message.role === "developer") {
			if (format === "openai-responses") {
				const payload: unknown = message.providerPayload;
				const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : undefined;
				const rebuilt = responsesUserParts(items?.[0]);
				if (rebuilt) {
					message.content = rebuilt;
					// The original item still holds the unnormalized image; send the rebuilt content instead.
					delete message.providerPayload;
				}
				continue;
			}
			if (urls.size === 0) continue;
			if (typeof message.content === "string") {
				const match = /^\[image: (.+)\]$/.exec(message.content);
				if (match && urls.has(match[1])) message.content = [urlImage(match[1])];
			} else {
				message.content = replacePlaceholders(message.content, urls);
			}
		} else if (message.role === "toolResult" && urls.size > 0) {
			message.content = replacePlaceholders(message.content, urls);
		}
	}
}

async function normalizeBase64(image: ImageContent): Promise<ImageContent> {
	const key = `${image.mimeType}:${Bun.hash(image.data).toString(36)}:${image.data.length}`;
	const cached = normalizedCache.get(key);
	if (cached) {
		remember(normalizedCache, key, cached);
		return { ...cached, ...(image.detail ? { detail: image.detail } : {}) };
	}
	const supported = await ensureSupportedImageInput({ type: "image", data: image.data, mimeType: image.mimeType });
	if (!supported) throw new ImageInputError(`Unsupported image format: ${image.mimeType}`);
	let normalized: ImageContent = { type: "image", data: supported.data, mimeType: supported.mimeType };
	try {
		const resized = await resizeImage(normalized);
		normalized = { type: "image", data: resized.data, mimeType: resized.mimeType };
	} catch {
		// Same as OMP: keep the supported image when resize fails.
	}
	remember(normalizedCache, key, normalized);
	return { ...normalized, ...(image.detail ? { detail: image.detail } : {}) };
}

async function download(url: string, signal: AbortSignal): Promise<ImageContent> {
	const cached = downloadCache.get(url);
	if (cached && Date.now() - cached.at < URL_CACHE_TTL_MS) return cached.image;
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) });
	} catch (error) {
		throw new ImageInputError(`Image download failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new ImageInputError(`Image download failed for ${url}: HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > DOWNLOAD_MAX_BYTES) throw new ImageInputError(`Image too large: ${url}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > DOWNLOAD_MAX_BYTES) throw new ImageInputError(`Image too large: ${url}`);
	const headerType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim();
	const mimeType = headerType.startsWith("image/") ? headerType : guessMimeType(url);
	const image: ImageContent = { type: "image", data: bytes.toBase64(), mimeType };
	remember(downloadCache, url, { image, at: Date.now() });
	return image;
}

async function prepareImage(image: ImageContent, provider: string, signal: AbortSignal): Promise<ImageContent> {
	if (image.data.length > 0) return normalizeBase64(image);
	if (!image.url) return image;
	const policy = URL_POLICY[provider];
	if (policy === "url" || (policy === "url-with-type" && image.mimeType.startsWith("image/"))) return image;
	const downloaded = await download(image.url, signal);
	return normalizeBase64({ ...downloaded, ...(image.detail ? { detail: image.detail } : {}) });
}

/** Normalize every image in user and tool-result messages for `provider`. Mutates `context`. */
export async function prepareImages(context: Context, provider: string, signal: AbortSignal): Promise<void> {
	for (const message of context.messages) {
		if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		const parts = message.content as Part[];
		if (!parts.some(part => part.type === "image")) continue;
		message.content = await Promise.all(
			parts.map(part => (part.type === "image" ? prepareImage(part, provider, signal) : part)),
		);
	}
}
