import { z } from "zod";
import { ensureValidJson } from "../../json-utils.js";
import type { MemoryService } from "../../memory/service.js";
import type { PaseoToolResult } from "./types.js";
import type { RegisterToolFn } from "./fleet-control-tools.js";

const NOTE_KINDS = [
  "decision",
  "fact",
  "howto",
  "owner",
  "runbook",
  "preference",
  "note",
  "learning",
] as const;
const SEARCH_KINDS = ["turn", "run", "ticket", "ticket_comment", "note", "doc"] as const;

export interface RegisterMemoryToolsOptions {
  registerTool: RegisterToolFn;
  /** Absent → memory is off on this host and the tools are not offered. */
  memoryService: MemoryService | null | undefined;
  /** The agent calling these tools (provenance for writes). */
  callerAgentId: string | undefined;
  /** Resolves the caller agent's display name for provenance. */
  resolveAgentName: (agentId: string) => Promise<string | null>;
  hostLabel: string;
}

function result(value: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(value) };
}

function unavailable(error: unknown): PaseoToolResult {
  return result({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

export function registerMemoryTools(options: RegisterMemoryToolsOptions): void {
  const { registerTool, memoryService, callerAgentId } = options;
  if (!memoryService) return;

  registerTool(
    "fleet_playbook",
    {
      title: "Read the operating doc",
      description:
        "The fleet's operating doc (OPERATING.md): roles, how work is placed and tracked, tickets, " +
        "notifications, safety rules, reporting style, runbooks. Policy only: it names the tools that " +
        "answer live questions. Read it first in a new session.",
      inputSchema: {},
    },
    async () => {
      try {
        return result({
          ok: true,
          ...((await memoryService.requireClient().playbook()) as object),
        });
      } catch (error) {
        return unavailable(error);
      }
    },
  );

  registerTool(
    "memory_search",
    {
      title: "Search fleet memory",
      description:
        "One search over everything the fleet remembers: agents' conversations (one hit per turn: the " +
        "user's prompt and the agent's replies), run records (briefs, reports, proofs), itsaplan tickets " +
        "and comments, and vault notes (decisions, owners, runbooks, OPERATING.md). Exact words, ids, " +
        "URLs and PR numbers rank first; meaning-based matches fill in after. Typos are corrected. Use " +
        "it to find who worked on something (byAgent: true), what was decided, or prior work. Each hit " +
        "has an id for memory_get and, for agent work, the agentId.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Keywords, an id, a URL, or a question."),
        kinds: z.array(z.enum(SEARCH_KINDS)).optional().describe("Only these kinds."),
        project: z.string().optional().describe("Only this project (title)."),
        agent: z.string().optional().describe("Only this agent id."),
        ticket: z.string().optional().describe("Only this ticket key, e.g. PASEO-71."),
        since: z.string().optional().describe("ISO date: only items at or after it."),
        limit: z.number().int().positive().max(30).optional().describe("Default 8."),
        byAgent: z
          .boolean()
          .optional()
          .describe("One hit per agent: for 'which agent did/owns X'."),
      },
    },
    async (input: {
      query: string;
      kinds?: string[];
      project?: string;
      agent?: string;
      ticket?: string;
      since?: string;
      limit?: number;
      byAgent?: boolean;
    }) => {
      try {
        const since = input.since ? Date.parse(input.since) : undefined;
        const found = await memoryService.requireClient().search({
          query: input.query,
          ...(input.kinds ? { kinds: input.kinds } : {}),
          ...(input.project ? { project: input.project } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.ticket ? { ticket: input.ticket } : {}),
          ...(since !== undefined && Number.isFinite(since) ? { since } : {}),
          limit: input.limit ?? 8,
          group_by_agent: input.byAgent === true,
        });
        return result({ ok: true, ...(found as object) });
      } catch (error) {
        return unavailable(error);
      }
    },
  );

  registerTool(
    "memory_get",
    {
      title: "Read one memory item",
      description:
        "The full text of an item from memory_search (turn:…, run:…, ticket:…, note:…, doc:…), with a " +
        "note's links and backlinks. For an agent's whole transcript use fleet_get_transcript.",
      inputSchema: { id: z.string().trim().min(1) },
    },
    async ({ id }: { id: string }) => {
      try {
        return result({
          ok: true,
          ...((await memoryService.requireClient().getDoc(id)) as object),
        });
      } catch (error) {
        return unavailable(error);
      }
    },
  );

  registerTool(
    "memory_write",
    {
      title: "Write to fleet memory",
      description:
        "Save something reusable as a vault note: who owns what (kind owner), a decision, a fact, a " +
        "how-to, a runbook, a preference. Same title → the note gets an update section. Mentions of " +
        "existing note titles are linked automatically; link others with [[Title]]. Who wrote it is " +
        "recorded by the daemon. Never write secrets. Queued and retried if memory is unreachable.",
      inputSchema: {
        title: z
          .string()
          .trim()
          .min(3)
          .max(120)
          .describe("Short topic title, e.g. 'notifyOnFinish callbacks'."),
        body: z.string().trim().min(1).describe("Markdown. Cite agents, tickets, PRs, commits."),
        kind: z.enum(NOTE_KINDS),
        tags: z.array(z.string()).optional(),
        about: z
          .object({
            agent: z.string().optional().describe("Agent id this is about (e.g. the owner)."),
            project: z.string().optional(),
            ticket: z.string().optional(),
            refs: z.array(z.string()).optional().describe("PR URLs, commits, files."),
          })
          .optional(),
      },
    },
    async (
      input: {
        title: string;
        body: string;
        kind: string;
        tags?: string[];
        about?: { agent?: string; project?: string; ticket?: string; refs?: string[] };
      },
      context,
    ) => {
      const agentName = callerAgentId ? await options.resolveAgentName(callerAgentId) : null;
      try {
        const written = await memoryService.writeNote({
          title: input.title,
          body: input.body,
          kind: input.kind,
          tags: input.tags ?? [],
          about: input.about ?? {},
          source: {
            ...(context.callerClient ? { client: context.callerClient } : {}),
            ...(callerAgentId ? { agent_id: callerAgentId } : {}),
            ...(agentName ? { agent_name: agentName } : {}),
            host: options.hostLabel,
          },
        });
        return result(
          written.queued
            ? {
                ok: true,
                queued: true,
                note: "memory is unreachable; the note is queued and will be written",
              }
            : { ok: true, ...(written.result as object) },
        );
      } catch (error) {
        return unavailable(error);
      }
    },
  );
}
