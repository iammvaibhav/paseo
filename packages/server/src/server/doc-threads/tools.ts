import { z } from "zod";
import type { DocThreadAnchor } from "@getpaseo/protocol/doc-threads/types";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { DocThreadsService } from "./service.js";

interface RegisterDocThreadToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  resolveService: () => DocThreadsService;
  callerAgentId?: string;
}

function result(data: unknown): PaseoToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function requireCaller(
  callerAgentId: string | undefined,
  context?: PaseoToolExecutionContext,
): string {
  const caller = callerAgentId ?? context?.sessionKey;
  if (!caller) throw new Error("Doc thread tools are only available to agent-scoped sessions");
  return caller;
}

const anchorSchema = z.object({
  quote: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  before: z.string().optional(),
  after: z.string().optional(),
});

export function registerDocThreadTools(options: RegisterDocThreadToolsOptions): void {
  options.registerTool(
    "reply_to_thread",
    {
      title: "Reply to a file thread",
      description: "Reply to a threaded comment on a file you are working with.",
      inputSchema: { threadId: z.string().min(1), body: z.string().trim().min(1) },
      outputSchema: { ok: z.boolean() },
    },
    async (raw, context) => {
      const args = z
        .object({ threadId: z.string().min(1), body: z.string().trim().min(1) })
        .parse(raw);
      const callerAgentId = requireCaller(options.callerAgentId, context);
      const thread = await options
        .resolveService()
        .replyToThread(
          { threadId: args.threadId, cwd: "", body: args.body },
          "agent",
          callerAgentId,
        );
      return result({ ok: true, thread });
    },
  );
  options.registerTool(
    "list_threads",
    {
      title: "List file comment threads",
      description: "List open and resolved file comment threads for your agent.",
      inputSchema: { path: z.string().optional() },
      outputSchema: { ok: z.boolean() },
    },
    async (raw, context) => {
      const args = z.object({ path: z.string().optional() }).parse(raw);
      const agentId = requireCaller(options.callerAgentId, context);
      const threads = await options
        .resolveService()
        .listThreads({ agentId, cwd: "", ...(args.path ? { path: args.path } : {}) });
      return result({ ok: true, threads });
    },
  );
  options.registerTool(
    "comment_on_file",
    {
      title: "Comment on a file",
      description: "Open a new threaded comment on a file you are working with.",
      inputSchema: {
        path: z.string().min(1),
        anchor: anchorSchema,
        body: z.string().trim().min(1),
      },
      outputSchema: { ok: z.boolean() },
    },
    async (raw, context) => {
      const args = z
        .object({ path: z.string().min(1), anchor: anchorSchema, body: z.string().trim().min(1) })
        .parse(raw);
      const agentId = requireCaller(options.callerAgentId, context);
      const thread = await options.resolveService().commentOnFile({
        agentId,
        path: args.path,
        anchor: args.anchor as DocThreadAnchor,
        body: args.body,
      });
      return result({ ok: true, thread });
    },
  );
}
