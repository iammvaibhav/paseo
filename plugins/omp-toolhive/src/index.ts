/**
 * omp-toolhive — ToolHive's three meta tools as always-loaded omp tools.
 *
 * omp presents MCP tools as "discoverable": with `tools.xdev` on they are
 * mounted under `xd://` and an agent only sees their names, so it rarely
 * thinks to search ToolHive. omp has no per-server setting to pin an MCP
 * server's tools top-level, but extension tools can declare
 * `loadMode: "essential"`. This extension registers `toolhive_find_tool`,
 * `toolhive_call_tool` and `toolhive_execute_tool_script` that way and speaks
 * streamable-HTTP MCP to ToolHive itself, so ToolHive must NOT also be listed
 * in omp's mcp.json (that would add a second, xd-mounted copy).
 *
 * Config: ~/.omp/agent/toolhive.json `{ "url": "...", "token": "..." }`
 * (written by flotilla, mode 600), or TOOLHIVE_URL / TOOLHIVE_TOKEN.
 * No config → the tools are not registered.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

interface ToolHiveConfig {
	url: string;
	token: string;
}

interface McpContentPart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface McpCallResult {
	content?: McpContentPart[];
	structuredContent?: unknown;
	isError?: boolean;
}

const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 120_000;

function readConfig(): ToolHiveConfig | null {
	const envUrl = process.env.TOOLHIVE_URL?.trim();
	const envToken = process.env.TOOLHIVE_TOKEN?.trim();
	if (envUrl && envToken) return { url: envUrl, token: envToken };
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const file = join(agentDir, "toolhive.json");
	if (!existsSync(file)) return null;
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ToolHiveConfig>;
	return typeof parsed.url === "string" && typeof parsed.token === "string"
		? { url: parsed.url, token: parsed.token }
		: null;
}

/** Minimal streamable-HTTP MCP client: one lazily opened session, reopened when it expires. */
class ToolHiveClient {
	#sessionId: string | null = null;
	#opening: Promise<string> | null = null;
	#nextId = 1;

	constructor(private readonly config: ToolHiveConfig) {}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		const sessionId = await this.#session(signal);
		const response = await this.#post(
			{ jsonrpc: "2.0", id: this.#nextId++, method: "tools/call", params: { name, arguments: args } },
			sessionId,
			signal,
		);
		if (response.status === 404 || response.status === 400) {
			// The server dropped the session (restart or idle expiry): open a new one once.
			this.#sessionId = null;
			const fresh = await this.#session(signal);
			return this.#readResult(
				await this.#post(
					{ jsonrpc: "2.0", id: this.#nextId++, method: "tools/call", params: { name, arguments: args } },
					fresh,
					signal,
				),
			);
		}
		return this.#readResult(response);
	}

	async #session(signal?: AbortSignal): Promise<string> {
		if (this.#sessionId) return this.#sessionId;
		this.#opening ??= this.#open(signal).finally(() => {
			this.#opening = null;
		});
		return this.#opening;
	}

	async #open(signal?: AbortSignal): Promise<string> {
		const response = await this.#post(
			{
				jsonrpc: "2.0",
				id: this.#nextId++,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "omp-toolhive", version: "0.1.0" },
				},
			},
			null,
			signal,
		);
		const sessionId = response.headers.get("mcp-session-id");
		if (!response.ok || !sessionId) {
			throw new Error(`ToolHive initialize failed: HTTP ${response.status}`);
		}
		await response.text();
		await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, signal).then((r) =>
			r.text(),
		);
		this.#sessionId = sessionId;
		return sessionId;
	}

	#post(body: unknown, sessionId: string | null, signal?: AbortSignal): Promise<Response> {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		return fetch(this.config.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	}

	async #readResult(response: Response): Promise<McpCallResult> {
		const raw = await response.text();
		if (!response.ok) throw new Error(`ToolHive HTTP ${response.status}: ${raw.slice(0, 300)}`);
		// JSON body, or an SSE stream whose data lines carry the JSON-RPC response.
		const payloads = raw.trimStart().startsWith("{")
			? [raw]
			: raw
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());
		for (const payload of payloads) {
			const message = JSON.parse(payload) as { result?: McpCallResult; error?: { message?: string } };
			if (message.error) throw new Error(`ToolHive: ${message.error.message ?? "request failed"}`);
			if (message.result) return message.result;
		}
		throw new Error("ToolHive returned no result");
	}
}

export default function ompToolHiveExtension(pi: ExtensionAPI): void {
	const config = readConfig();
	if (!config) return;
	const client = new ToolHiveClient(config);
	const z = pi.zod;

	const register = (
		name: string,
		upstream: string,
		label: string,
		description: string,
		parameters: ToolDefinition["parameters"],
	) => {
		pi.registerTool({
			name,
			label,
			description,
			parameters,
			loadMode: "essential",
			approval: upstream === "find_tool" ? "read" : "exec",
			mcpServerName: "toolhive",
			mcpToolName: upstream,
			async execute(_id, params, signal) {
				const result = await client.callTool(upstream, params as Record<string, unknown>, signal);
				const content = (result.content ?? []).filter((part) => part.type === "text");
				return {
					content: content.length > 0 ? content.map((part) => ({ type: "text", text: part.text ?? "" })) : [{ type: "text", text: "" }],
					// Same shape omp's own MCP tools report, so Paseo renders the parsed result.
					details: {
						serverName: "toolhive",
						mcpToolName: upstream,
						rawContent: result.content ?? [],
						...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
						...(result.isError ? { isError: true } : {}),
					},
					...(result.isError ? { isError: true } : {}),
				};
			},
		});
	};

	const reason = z.string().describe("One short sentence on why this call is needed. Used for approval and audit only.");

	register(
		"toolhive_find_tool",
		"find_tool",
		"ToolHive find tool",
		"Find tools on the fleet's shared MCP servers (Paseo fleet and memory, itsaplan, GitHub, Linear, Jira/Confluence, Slack, Google Workspace, WhatsApp, X and web search, n8n, Figma, Statsig, PagerDuty). Semantic plus keyword search; returns tool names and input schemas. Call it before toolhive_call_tool or toolhive_execute_tool_script for a tool whose name and schema you have not seen in this session.",
		z.object({
			tool_description: z
				.string()
				.describe("Description of the task or capability needed, e.g. 'list paseo agents', 'search slack messages'."),
			tool_keywords: z.array(z.string()).optional().describe("Optional keywords for the keyword-search arm."),
		}),
	);
	register(
		"toolhive_call_tool",
		"call_tool",
		"ToolHive call tool",
		"Run one tool found with toolhive_find_tool. For two or more calls, or to return only some fields of a result, use toolhive_execute_tool_script instead.",
		z.object({
			tool_name: z.string().describe("The tool's name exactly as toolhive_find_tool returned it, e.g. paseo-fleet_list_agents."),
			parameters: z.record(z.string(), z.unknown()).describe("Arguments matching the tool's input schema."),
			reason,
		}),
	);
	register(
		"toolhive_execute_tool_script",
		"execute_tool_script",
		"ToolHive tool script",
		[
			"Run a Starlark script that calls several ToolHive tools and returns one aggregated result. Use `return` to produce output.",
			"Call a tool by its name with every character that is not a letter, digit or underscore replaced by `_` (paseo-fleet_list_agents → paseo_fleet_list_agents(limit=5)), or call_tool(\"name\", ...).",
			"parallel([fn1, fn2, ...]) runs zero-arg callables concurrently and returns results in order; in a loop bind with a default (lambda x=x: f(id=x)).",
			"Built-in json module: json.decode, json.encode, json.indent. Values in `data` become top-level variables. Return only the fields you need.",
		].join("\n"),
		z.object({
			script: z.string().describe("The Starlark script."),
			data: z.record(z.string(), z.unknown()).optional().describe("Named values injected as top-level variables."),
			reason,
		}),
	);
}
