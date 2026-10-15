// The MCP tools. Both are read-only: Grok's x_search and web_search only read.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { askGrok, type GrokRequest, MODEL, type WebSearchTool, type XSearchTool } from "./grok";

const X_SYSTEM = `You are the X (Twitter) reader behind an API tool. Read X only with your X search tools; never answer from memory or invent posts, handles, numbers, or URLs.
Pick the search that fits the request: keyword search (Latest or Top) for posts, semantic search for topics, user search for accounts, thread fetch for one post with its replies.
Report only what the tools returned:
- For each post: author display name and @handle, UTC timestamp, post URL (https://x.com/<handle>/status/<id>), the full post text quoted verbatim, then engagement counts when available (replies, reposts, likes, views). Mention attached media, quoted posts, and links.
- For each account: display name, @handle, profile URL, bio, follower and following counts, verified status, join date when available.
- For a question: a concise answer that cites the post URL for every claim.
If nothing matches, say so in one line. No preamble, no commentary, no follow-up suggestions.`;

const WEB_SYSTEM = `You are the web search engine behind an API tool. Search the web with your web search tool; never answer from memory.
Answer concisely and factually, cite the source URL for every claim, and prefer primary sources (official docs, release notes, the author's own site). Say when sources disagree or nothing was found. No preamble, no follow-up suggestions.`;

const handle = z
  .string()
  .regex(/^@?[A-Za-z0-9_]{1,15}$/, "an X handle like @xai or xai")
  .transform((value) => value.replace(/^@/, ""));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const domain = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "a domain like bun.com");
const depth = z
  .enum(["quick", "thorough"])
  .default("quick")
  .describe(
    "quick = up to 2 search rounds; thorough = up to 5 (slower, uses more Grok Build credits)",
  );

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

async function run(name: string, request: GrokRequest): Promise<CallToolResult> {
  try {
    const result = await askGrok(request);
    const stats = `${result.xSearchCalls} X searches (${result.postsFetched} posts, ${result.usersFetched} profiles), ${result.webSearchCalls} web searches, ${(result.durationMs / 1000).toFixed(1)}s`;
    console.log(`[x-search] ${name}: ${stats}`);
    const parts = [result.text || "(no answer)"];
    if (result.sources.length > 0)
      parts.push(`Sources:\n${result.sources.map((url) => `- ${url}`).join("\n")}`);
    parts.push(`[${MODEL}: ${stats}]`);
    return { content: [{ type: "text", text: parts.join("\n\n") }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[x-search] ${name} failed: ${message}`);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "x_search",
    {
      title: "Search and read X",
      description: `Search and read X (Twitter) live through Grok's X index. Read-only. One tool for everything on X:
- find posts by keywords, phrases, hashtags, or topic, newest or most popular first
- read one post or thread by URL or ID, with replies, quoted posts, and media
- list an account's recent posts, replies, or media posts
- find accounts and show their profiles (bio, followers, verified status)
- answer a question from what people post on X, citing post URLs
Returns posts verbatim with author, time, URL, and engagement counts, plus source URLs. The request may use X search syntax: "exact phrase", OR, -word, #tag, from:handle, to:handle, filter:media, -filter:replies, min_faves:N, lang:en.`,
      inputSchema: {
        request: z
          .string()
          .min(1)
          .describe(
            'What to find or read, in plain words or X search syntax, or a post URL. E.g. "latest posts from @karpathy", "https://x.com/xai/status/123 with replies", "what people say about Bun 1.3", "from:elonmusk filter:media"',
          ),
        handles: z.array(handle).max(10).optional().describe("Only posts by these accounts"),
        exclude_handles: z
          .array(handle)
          .max(10)
          .optional()
          .describe("Never posts by these accounts"),
        since: date.optional().describe("Earliest post date, YYYY-MM-DD (inclusive)"),
        until: date.optional().describe("Latest post date, YYYY-MM-DD (inclusive)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum posts or accounts to return"),
        depth,
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const tool: XSearchTool = { type: "x_search" };
      if (args.handles?.length) tool.allowed_x_handles = args.handles;
      else if (args.exclude_handles?.length) tool.excluded_x_handles = args.exclude_handles;
      if (args.since) tool.from_date = args.since;
      if (args.until) tool.to_date = args.until;
      return run("x_search", {
        system: X_SYSTEM,
        user: `${args.request}\n\nReturn at most ${args.limit} posts or accounts.`,
        tools: [tool],
        maxTurns: args.depth === "thorough" ? 5 : 2,
      });
    },
  );

  server.registerTool(
    "x_web_search",
    {
      title: "Search the web (Grok)",
      description:
        "Search the open web live through Grok's web search, which can also open pages and read them. Read-only. Answers concisely with a source URL for every claim. Use x_search for X (Twitter) content. Slower than x_search (often 10-30 s).",
      inputSchema: {
        query: z.string().min(1).describe("The question or search query"),
        domains: z
          .array(domain)
          .max(5)
          .optional()
          .describe("Only search these domains, e.g. bun.com"),
        exclude_domains: z.array(domain).max(5).optional().describe("Never search these domains"),
        depth,
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const tool: WebSearchTool = { type: "web_search" };
      if (args.domains?.length) tool.filters = { allowed_domains: args.domains };
      else if (args.exclude_domains?.length)
        tool.filters = { excluded_domains: args.exclude_domains };
      return run("x_web_search", {
        system: WEB_SYSTEM,
        user: args.query,
        tools: [tool],
        maxTurns: args.depth === "thorough" ? 5 : 2,
      });
    },
  );
}
