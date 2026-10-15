// The MCP tools. Every tool is read-only: Grok's x_search can only read X.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { askGrok, type GrokRequest, MODEL, type XSearchTool } from "./grok";

const SYSTEM = `You are the X (Twitter) reader behind an API tool. Read X only with your X search tools; never answer from memory or invent posts, handles, numbers, or URLs.
Report only what the tools returned:
- For each post: author display name and @handle, UTC timestamp, post URL (https://x.com/<handle>/status/<id>), the full post text quoted verbatim, then engagement counts when available (replies, reposts, likes, views). Mention attached media, quoted posts, and links.
- For each account: display name, @handle, profile URL, bio, follower and following counts, verified status, join date when available.
If nothing matches, say so in one line. No preamble, no commentary, no follow-up suggestions.`;

const handle = z
  .string()
  .regex(/^@?[A-Za-z0-9_]{1,15}$/, "an X handle like @xai or xai")
  .transform((value) => value.replace(/^@/, ""));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const limit = (fallback: number) => z.number().int().min(1).max(25).default(fallback);

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

async function run(name: string, request: Omit<GrokRequest, "system">): Promise<CallToolResult> {
  try {
    const result = await askGrok({ system: SYSTEM, ...request });
    const stats = `${result.xSearchCalls} X searches, ${result.postsFetched} posts and ${result.usersFetched} profiles fetched, ${(result.durationMs / 1000).toFixed(1)}s`;
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
      title: "Search X posts",
      description:
        'Search posts on X (Twitter) and return matching posts verbatim with author, time, URL, and engagement. The query accepts X search syntax: keywords, "exact phrase", OR, -exclude, #hashtag, from:handle, to:handle, filter:media, -filter:replies, min_faves:N, lang:en.',
      inputSchema: {
        query: z.string().min(1).describe("Search query in X search syntax"),
        mode: z
          .enum(["latest", "top"])
          .default("latest")
          .describe("latest = newest first; top = most engaged"),
        limit: limit(10).describe("Maximum posts to return (1-25)"),
        from_handles: z.array(handle).max(10).optional().describe("Only posts by these accounts"),
        exclude_handles: z
          .array(handle)
          .max(10)
          .optional()
          .describe("Never posts by these accounts"),
        since: date.optional().describe("Earliest post date, YYYY-MM-DD (inclusive)"),
        until: date.optional().describe("Latest post date, YYYY-MM-DD (inclusive)"),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const tool: XSearchTool = { type: "x_search" };
      if (args.from_handles?.length) tool.allowed_x_handles = args.from_handles;
      else if (args.exclude_handles?.length) tool.excluded_x_handles = args.exclude_handles;
      if (args.since) tool.from_date = args.since;
      if (args.until) tool.to_date = args.until;
      return run("x_search", {
        user: `Search X posts with the query: ${args.query}\nOrder: ${args.mode === "top" ? "Top (most engaged)" : "Latest (newest first)"}. Return up to ${args.limit} matching posts.`,
        tools: [tool],
        maxTurns: 3,
      });
    },
  );

  server.registerTool(
    "x_get_post",
    {
      title: "Read an X post",
      description:
        "Read one X (Twitter) post by URL or numeric ID: full text, author, time, engagement, media, quoted post, and optionally its replies.",
      inputSchema: {
        post: z
          .string()
          .regex(
            /^(\d{5,25}|https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^\s]+\/status(es)?\/\d{5,25}\S*)$/,
            "a post URL (https://x.com/<handle>/status/<id>) or numeric post ID",
          )
          .describe("Post URL or numeric post ID"),
        replies: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(0)
          .describe("Also list up to this many replies (0 = none)"),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const url = /^\d+$/.test(args.post) ? `https://x.com/i/status/${args.post}` : args.post;
      const replies =
        args.replies > 0
          ? ` Then list up to ${args.replies} replies to it, each with author, time, URL, and verbatim text.`
          : "";
      return run("x_get_post", {
        user: `Read this X post and return it in full: ${url}.${replies}`,
        tools: [{ type: "x_search" }],
        maxTurns: args.replies > 0 ? 3 : 2,
      });
    },
  );

  server.registerTool(
    "x_user_posts",
    {
      title: "List an X account's posts",
      description:
        "List the most recent posts, replies, or media posts by one X (Twitter) account.",
      inputSchema: {
        handle: handle.describe("Account handle, e.g. @xai"),
        tab: z
          .enum(["posts", "replies", "media"])
          .default("posts")
          .describe(
            "posts = original posts and reposts without replies; replies = everything; media = posts with media",
          ),
        limit: limit(10).describe("Maximum posts to return (1-25)"),
        since: date.optional().describe("Earliest post date, YYYY-MM-DD (inclusive)"),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const filter = { posts: " -filter:replies", replies: "", media: " filter:media" }[args.tab];
      const tool: XSearchTool = { type: "x_search", allowed_x_handles: [args.handle] };
      if (args.since) tool.from_date = args.since;
      return run("x_user_posts", {
        user: `List the ${args.limit} most recent posts by @${args.handle}, newest first (X query: from:${args.handle}${filter}, Latest).`,
        tools: [tool],
        maxTurns: 2,
      });
    },
  );

  server.registerTool(
    "x_search_users",
    {
      title: "Find X accounts",
      description:
        "Find X (Twitter) accounts by name, handle, or topic and return their profiles: handle, bio, followers, verified status.",
      inputSchema: {
        query: z.string().min(1).describe("Name, handle, or topic to look up"),
        limit: limit(5).describe("Maximum accounts to return (1-25)"),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run("x_search_users", {
        user: `Find X accounts matching: ${args.query}. Return up to ${args.limit} profiles, best match first.`,
        tools: [{ type: "x_search" }],
        maxTurns: 2,
      }),
  );

  server.registerTool(
    "x_ask",
    {
      title: "Ask about X",
      description:
        "Answer a free-form question from what is being posted on X (Twitter), e.g. what people say about a topic, an account's stance, or the reaction to an event. Searches X as needed and cites post URLs. Slower than the other tools.",
      inputSchema: {
        question: z.string().min(1).describe("The question to answer from X"),
        include_web: z.boolean().default(false).describe("Also search the web, not only X"),
        since: date.optional().describe("Only consider posts from this date, YYYY-MM-DD"),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      const tool: XSearchTool = { type: "x_search" };
      if (args.since) tool.from_date = args.since;
      return run("x_ask", {
        user: `${args.question}\n\nAnswer concisely from what you find on X. Cite the post URL for every claim.`,
        tools: args.include_web ? [tool, { type: "web_search" }] : [tool],
        maxTurns: 5,
      });
    },
  );
}
