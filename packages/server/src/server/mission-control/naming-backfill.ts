import { z } from "zod";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { hasMissionControlLabels } from "./naming.js";

/**
 * Pure logic for the one-time Mission Control naming backfill
 * (docs/mission-control.md, "Naming backfill (one-time, via omp scout — no
 * in-daemon provider calls)").
 *
 * The backfill runs as an omp one-shot per host against daemon RPCs, driven
 * by `scripts/mc-backfill.mjs`. Everything in this module is deterministic
 * and side-effect free so it is unit-testable without a daemon; the script
 * owns all I/O (client RPCs, the omp spawn, file reads).
 *
 * Two passes:
 *   1. Agent identity: assign name + title + description to existing agents
 *      missing them, and REPLACE titles that equal the deterministic
 *      first-prompt derivation (auto-generated; user-set titles are never
 *      touched). Idempotent: complete agents with user-set titles are
 *      skipped. The one-shot produces the values in bulk JSON; the script
 *      applies them via the `update_agent_request` RPC
 *      (name/title/shortDescription).
 *   2. Workspace rename proposals: every non-system, non-home workspace goes
 *      into the SAME omp one-shot with its agents' titles+descriptions as
 *      context; the LLM proposes a new descriptive name (max 5 words) ONLY
 *      for names that read as auto-generated (slugs, bare project/dir names,
 *      worktree slugs), keeping human-looking names untouched. The script
 *      emits them as a single Mission Control proposal card (kind
 *      "proposal", origin commander, classification normal) and never
 *      auto-applies; applying is a separate `--apply` step driven by the
 *      `workspace.title.set.request` RPC.
 */

/** Description length cap, mirrored by the server-side description generator. */
export const DESCRIPTION_MAX_CHARS = 400;
/** Proposal titles are capped at 5 words per spec. */
export const WORKSPACE_PROPOSAL_MAX_WORDS = 5;

export interface BackfillAgentInput {
  agentId: string;
  name?: string | null;
  title?: string | null;
  shortDescription?: string | null;
  labels?: Record<string, string>;
  cwd?: string;
  archivedAt?: string | null;
  internal?: boolean;
  /** First user prompt excerpt (~200 chars, metadata-driven; never a transcript). */
  firstPrompt?: string | null;
  /** Headline of the agent's most recent report_status self-report. */
  lastReportHeadline?: string | null;
}

export interface BackfillCandidate {
  agentId: string;
  name: string | null;
  title: string | null;
  shortDescription: string | null;
  cwd: string;
  firstPrompt: string | null;
  lastReportHeadline: string | null;
}

/** One agent row the one-shot is asked to produce identity for. */
export interface BackfillPromptAgent {
  agentId: string;
  title: string | null;
  cwd: string;
}

/** Idempotency filter: an agent is complete once it has all three identity fields. */
export function hasFullIdentity(
  agent: Pick<BackfillAgentInput, "name" | "title" | "shortDescription">,
): boolean {
  return Boolean(agent.name?.trim() && agent.title?.trim() && agent.shortDescription?.trim());
}

/**
 * An agent needs the backfill when it misses at least one identity field or
 * its title equals the deterministic first-prompt derivation (auto-generated
 * → replaceable), and it is not machinery or archived. Mission-control-labeled
 * agents (Commander, Verifier, future monitors) are invisible to the fleet
 * and never renamed.
 */
export function isAgentBackfillEligible(agent: BackfillAgentInput): boolean {
  if (agent.archivedAt) {
    return false;
  }
  if (agent.internal === true) {
    return false;
  }
  if (hasMissionControlLabels(agent.labels ?? {})) {
    return false;
  }
  if (!hasFullIdentity(agent)) {
    return true;
  }
  // Complete agent: eligible only when its title is auto-generated (equals
  // the deterministic derivation from the first user prompt) — user-set
  // titles are never touched.
  const derived = deriveTitleFromFirstPrompt(agent.firstPrompt ?? null);
  const title = agent.title?.trim();
  return Boolean(title && derived !== null && title === derived);
}

export function selectBackfillCandidates(
  agents: readonly BackfillAgentInput[],
): BackfillCandidate[] {
  const candidates: BackfillCandidate[] = [];
  for (const agent of agents) {
    if (!isAgentBackfillEligible(agent)) {
      continue;
    }
    candidates.push({
      agentId: agent.agentId,
      name: agent.name?.trim() || null,
      title: agent.title?.trim() || null,
      shortDescription: agent.shortDescription?.trim() || null,
      cwd: agent.cwd?.trim() || "",
      firstPrompt: agent.firstPrompt?.trim() || null,
      lastReportHeadline: agent.lastReportHeadline?.trim() || null,
    });
  }
  return candidates;
}

/**
 * The one-shot prompt. One call per host; the agent replies with a single
 * JSON object covering every candidate. The naming theme comes from the
 * central Mission Control config (`mission_control.config.get` →
 * `config.namingTheme`).
 */
export function buildBackfillPrompt(input: {
  hostLabel: string;
  namingTheme: string;
  candidates: readonly BackfillCandidate[];
  workspaceCandidates?: readonly WorkspaceProposalCandidate[];
}): string {
  const { hostLabel, namingTheme, candidates, workspaceCandidates = [] } = input;
  const lines = candidates.map(
    (candidate, index) =>
      `${index + 1}. agentId=${candidate.agentId}${candidate.title ? ` | current title: ${candidate.title}` : ""} | cwd: ${candidate.cwd || "(unknown)"}${candidate.firstPrompt ? ` | first user prompt: "${candidate.firstPrompt}"` : ""}${candidate.lastReportHeadline ? ` | last report: "${candidate.lastReportHeadline}"` : ""}`,
  );
  const workspaceLines = workspaceCandidates.map((candidate, index) => {
    const agentContext = candidate.agents
      .map((agent) => {
        const title = agent.title?.trim();
        const description = agent.shortDescription?.trim();
        if (title && description) {
          return `"${title}" — ${description}`;
        }
        return `"${title ?? description ?? "(no identity yet)"}"`;
      })
      .join(" | ");
    return `${index + 1}. workspaceId=${candidate.workspaceId} | current name: "${candidate.name}"${agentContext ? ` | agents working here: ${agentContext}` : ""}`;
  });
  const sections = [
    "You are the naming pass of a one-time fleet identity backfill for the Mission Control board.",
    `Host: ${hostLabel}.`,
    "",
    `Naming theme: "${namingTheme}". Choose the agent's name (the short identity chip) to fit this theme; keep names short, fun, and unique across the fleet.`,
    "",
    "For each agent below produce exactly three fields:",
    '- "name": short identity chip fitting the theme (1-2 words). If the agent already has a name, KEEP IT UNCHANGED and still echo it back.',
    '- "title": a concise task title (max 8 words, plain language) describing what the agent is working on.',
    '- "description": 2-3 living sentences (max 400 chars, present tense, no markdown) describing what the agent is doing — this is the Commander\'s context, so a little more is better.',
    "",
    "Derive each title from what was ACTUALLY asked: use the agent's first user prompt excerpt (and the last report headline when present) as the source material — never the current title, which may be the auto-derived placeholder being replaced.",
    "Use the current title and cwd only as supporting context. Never invent agentIds. Never include secrets or raw file contents.",
  ];
  if (workspaceLines.length > 0) {
    sections.push(
      "",
      'Workspaces: for each workspace below, decide whether its current name reads as AUTO-GENERATED — branch/dir slugs ("feat/payments", "vaibhav/customizations", "main"), bare project or directory names ("stackmod", "breezeapi"), Paseo worktree slugs (random word pairs like "thankful-penguin" or names ending in "-wt-"), or awkward machine names. For those, propose a NEW descriptive name (max 5 words, plain language, no branch prefixes or separators) that reflects what its agents actually work on — use the listed agents\' titles/descriptions as context. If the current name already reads as an intentional human name (a real task label like "Explain advisory feed freshness for npm install checks"), return NO proposal for it: omit it from the "workspaces" array. Never propose for workspaces not listed.',
      "",
      "Workspaces:",
      ...workspaceLines,
    );
  }
  sections.push(
    "",
    "Reply with ONLY a JSON object, no prose, no code fences:",
    '{"agents":[{"agentId":"...","name":"...","title":"...","description":"..."}],"workspaces":[{"workspaceId":"...","name":"..."}]}',
    "",
    "Agents:",
    ...lines,
  );
  return sections.join("\n");
}

/** Wire shape of the one-shot's bulk JSON response. */
export const BackfillWorkspaceResponseSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
});

export type BackfillWorkspaceResponse = z.infer<typeof BackfillWorkspaceResponseSchema>;

export const BackfillResponseSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.string().min(1),
      name: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
  workspaces: z.array(BackfillWorkspaceResponseSchema).optional(),
});

export type BackfillAgentResponse = z.infer<typeof BackfillResponseSchema>["agents"][number];

export interface BackfillParsedResponse {
  agents: BackfillAgentResponse[];
  workspaces: BackfillWorkspaceResponse[];
}

/**
 * Tolerant parse of the one-shot stdout: strips fenced blocks and leading
 * noise (omp prints "Working..."), extracts the first balanced {...} JSON
 * object, and validates it against {@link BackfillResponseSchema}. Returns
 * null when no valid payload is found.
 */
export function parseBackfillResponse(output: string): BackfillParsedResponse | null {
  const open = output.indexOf("{");
  if (open === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = open; i < output.length; i += 1) {
    const char = output[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(open, end + 1));
  } catch {
    return null;
  }
  const result = BackfillResponseSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return { agents: result.data.agents, workspaces: result.data.workspaces ?? [] };
}

/**
 * Deterministic derived title for an agent's first user prompt, using the
 * SAME derivation as create-agent-title.ts (first content line,
 * whitespace-collapsed, clamped). When the stored title equals this
 * derivation the title was auto-generated and is safe to replace.
 */
export function deriveTitleFromFirstPrompt(prompt: string | null): string | null {
  if (!prompt || prompt.trim().length === 0) {
    return null;
  }
  return resolveCreateAgentTitles({ initialPrompt: prompt }).provisionalTitle;
}

export interface BackfillIdentityUpdate {
  agentId: string;
  name?: string;
  title?: string;
  shortDescription?: string;
}

/**
 * Fold the one-shot's responses into per-agent updates:
 *
 * - name / description: fill ONLY when the candidate still misses them and
 *   the response provides a value (unchanged).
 * - title: fill when missing; REPLACE when the current title equals the
 *   deterministic derivation from the first user prompt (auto-generated →
 *   the LLM proposal wins); anything else is user-set and untouched.
 *
 * This is the apply-time idempotency filter: a completed agent is never
 * touched, and a response that repeats an existing value is a no-op.
 */
export function resolveIdentityUpdates(input: {
  candidates: readonly BackfillCandidate[];
  responses: readonly BackfillAgentResponse[];
}): BackfillIdentityUpdate[] {
  const byId = new Map(input.candidates.map((candidate) => [candidate.agentId, candidate]));
  const updates: BackfillIdentityUpdate[] = [];
  for (const response of input.responses) {
    const candidate = byId.get(response.agentId);
    if (!candidate) {
      continue;
    }
    const update: BackfillIdentityUpdate = { agentId: response.agentId };
    const name = response.name?.trim();
    if (name && !candidate.name) {
      update.name = name;
    }
    const title = response.title?.trim();
    if (title) {
      const derived = deriveTitleFromFirstPrompt(candidate.firstPrompt);
      if (!candidate.title) {
        update.title = title;
      } else if (derived !== null && candidate.title === derived) {
        update.title = title;
      }
    }
    const description = response.description?.trim();
    if (description && description.length <= DESCRIPTION_MAX_CHARS && !candidate.shortDescription) {
      update.shortDescription = description;
    }
    if (update.name || update.title || update.shortDescription) {
      updates.push(update);
    }
  }
  return updates;
}

// ============================================================================
// Workspace rename proposals
// ============================================================================

export interface WorkspaceAgentContextInput {
  title?: string | null;
  shortDescription?: string | null;
}

export interface WorkspaceBackfillInput {
  workspaceId: string;
  name: string;
  title?: string | null;
  /** Workspace directory (payload `workspaceDirectory`/`projectRootPath`) for system-home exclusion. */
  cwd?: string | null;
  /** The workspace's agents (titles + descriptions) so proposals reflect actual work. */
  agents?: readonly WorkspaceAgentContextInput[];
}

export interface WorkspaceRenameProposal {
  workspaceId: string;
  oldName: string;
  newName: string;
}

/** A workspace the one-shot is asked to propose a new name for. */
export interface WorkspaceProposalCandidate {
  workspaceId: string;
  name: string;
  agents: readonly WorkspaceAgentContextInput[];
}

/**
 * The Commander's home workspace marker; never a rename candidate.
 */
export function isSystemWorkspaceName(name: string | null | undefined): boolean {
  return (name?.trim() ?? "") === "<paseo-system>";
}

function normalizeDirForCompare(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, "");
}

/**
 * Candidate selection for the workspace pass. Auto-generated workspace names
 * are NOT distinguishable from user-set ones on the wire (Paseo's auto-namer
 * also writes the `title` field), so every non-system, non-home workspace is
 * sent to the bulk one-shot WITH its agents (titles + descriptions) as
 * context; the LLM decides which names read as auto-generated and proposes
 * renames for those only (human-looking names get no proposal). Every
 * proposal is human-gated (report review + `--apply`), so biasing toward
 * more candidates is safe. System/home workspaces (the Commander's
 * `<paseo-system>` home and the ambient home-dir workspace) are machinery,
 * not user work — never rename.
 */
export function selectWorkspaceProposalCandidates(
  workspaces: readonly WorkspaceBackfillInput[],
  options: { homeDir?: string | null } = {},
): WorkspaceProposalCandidate[] {
  const home = options.homeDir?.trim() ? normalizeDirForCompare(options.homeDir.trim()) : null;
  const candidates: WorkspaceProposalCandidate[] = [];
  for (const workspace of workspaces) {
    if (isSystemWorkspaceName(workspace.name) || isSystemWorkspaceName(workspace.title)) {
      continue;
    }
    if (home && workspace.cwd && normalizeDirForCompare(workspace.cwd) === home) {
      continue;
    }
    candidates.push({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      agents: workspace.agents ?? [],
    });
  }
  return candidates;
}

/**
 * Fold the one-shot's workspace responses into old→new proposals: only
 * responses for known candidate workspaceIds, with a non-empty name that is
 * at most {@link WORKSPACE_PROPOSAL_MAX_WORDS} words and actually differs
 * from the current name. Anything else is dropped (no fallback title-casing).
 */
export function resolveWorkspaceRenameProposals(
  candidates: readonly WorkspaceProposalCandidate[],
  responses: readonly BackfillWorkspaceResponse[],
): WorkspaceRenameProposal[] {
  const byId = new Map(candidates.map((candidate) => [candidate.workspaceId, candidate]));
  const proposals: WorkspaceRenameProposal[] = [];
  for (const response of responses) {
    const candidate = byId.get(response.workspaceId);
    if (!candidate) {
      continue;
    }
    const newName = response.name.trim();
    const words = newName.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > WORKSPACE_PROPOSAL_MAX_WORDS) {
      continue;
    }
    if (newName === candidate.name) {
      continue;
    }
    proposals.push({ workspaceId: response.workspaceId, oldName: candidate.name, newName });
  }
  return proposals;
}

/** The proposal card body: one 'old -> new' line per workspace. */
export function formatRenameProposalMessage(
  proposals: readonly WorkspaceRenameProposal[],
  hostLabel: string,
): string {
  const lines = proposals.map((proposal) => `${proposal.oldName} -> ${proposal.newName}`);
  const host = hostLabel.trim()
    ? hostLabel.trim().charAt(0).toUpperCase() + hostLabel.trim().slice(1)
    : "this host";
  return [
    `Workspace rename proposals (${proposals.length}) on ${host}. Applying is manual: run the backfill script with --apply <approved.json>; nothing below has been changed.`,
    "",
    ...lines,
  ].join("\n");
}

// ============================================================================
// Markdown backfill report (--report <path>.md)
// ============================================================================

/** One changed identity field, for the old → new report table. */
export interface BackfillIdentityChangeRow {
  agentId: string;
  field: "name" | "title" | "description";
  oldValue: string | null;
  newValue: string;
}

/**
 * Diff candidates against the resolved updates into per-field change rows.
 * Only fields the update actually changes appear; unchanged fields are
 * omitted so the report stays reviewable.
 */
export function buildBackfillReportAgentChanges(
  candidates: readonly BackfillCandidate[],
  updates: readonly BackfillIdentityUpdate[],
): BackfillIdentityChangeRow[] {
  const byId = new Map(candidates.map((candidate) => [candidate.agentId, candidate]));
  const rows: BackfillIdentityChangeRow[] = [];
  for (const update of updates) {
    const candidate = byId.get(update.agentId);
    if (!candidate) {
      continue;
    }
    if (update.name !== undefined) {
      rows.push({
        agentId: update.agentId,
        field: "name",
        oldValue: candidate.name,
        newValue: update.name,
      });
    }
    if (update.title !== undefined) {
      rows.push({
        agentId: update.agentId,
        field: "title",
        oldValue: candidate.title,
        newValue: update.title,
      });
    }
    if (update.shortDescription !== undefined) {
      rows.push({
        agentId: update.agentId,
        field: "description",
        oldValue: candidate.shortDescription,
        newValue: update.shortDescription,
      });
    }
  }
  return rows;
}

/**
 * Human-reviewable markdown report per host: old → new tables for agent
 * identity (name/title/description) and workspace renames, with a short
 * how-to-approve header. The user reviews it and rejects rows by deleting
 * them; `--apply <file>` consumes only the approved file.
 */
export function buildBackfillMarkdownReport(input: {
  hostLabel: string;
  namingTheme: string;
  /** ISO timestamp; the caller supplies it so tests stay deterministic. */
  generatedAt: string;
  agentChanges: readonly BackfillIdentityChangeRow[];
  workspaceProposals: readonly WorkspaceRenameProposal[];
}): string {
  const { hostLabel, namingTheme, generatedAt, agentChanges, workspaceProposals } = input;
  const sections: string[] = [
    "# Mission Control naming backfill report",
    "",
    `- Host: \`${hostLabel}\``,
    `- Naming theme: \`${namingTheme}\``,
    `- Generated: ${generatedAt}`,
    "",
    "## How to approve",
    "",
    "This report lists every change the backfill proposes. **Nothing has been applied yet.**",
    "",
    "1. Review the tables below and **delete any row you reject**.",
    "2. Agent identity changes (name/title/description) are applied when you re-run the backfill **without** `--dry-run`.",
    "3. Workspace renames are never auto-applied. Approve them by running:",
    "",
    "```sh",
    "node --import tsx scripts/mc-backfill.mjs --host <host> --apply <approved.json>",
    "```",
    "",
    'where `<approved.json>` is a JSON array of `{ "workspaceId": "...", "newName": "..." }` entries for the rows you kept.',
    "",
  ];

  if (agentChanges.length > 0) {
    sections.push(
      "## Agent identity changes",
      "",
      "| Agent | Field | Old | New |",
      "| --- | --- | --- | --- |",
      ...agentChanges.map(
        (change) =>
          `| ${change.agentId} | ${change.field} | ${change.oldValue ?? "—"} | ${change.newValue} |`,
      ),
      "",
    );
  } else {
    sections.push("## Agent identity changes", "", "_No agent identity changes._", "");
  }

  if (workspaceProposals.length > 0) {
    sections.push(
      "## Workspace renames",
      "",
      "| Workspace | Old name | New name |",
      "| --- | --- | --- |",
      ...workspaceProposals.map(
        (proposal) => `| ${proposal.workspaceId} | ${proposal.oldName} | ${proposal.newName} |`,
      ),
      "",
    );
  } else {
    sections.push("## Workspace renames", "", "_No workspace renames._", "");
  }

  return sections.join("\n");
}
