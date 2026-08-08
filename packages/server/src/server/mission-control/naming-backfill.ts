import { z } from "zod";
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
 *      missing them. Idempotent: an agent with all three fields is skipped.
 *      The one-shot produces the values in bulk JSON; the script applies them
 *      via the `update_agent_request` RPC (name/title/shortDescription).
 *   2. Workspace rename proposals: old→new proposals (max 5 words, descriptive)
 *      ONLY for titles equal to derived defaults (branch/dir slugs). The
 *      script emits them as a single Mission Control proposal card
 *      (kind "proposal", origin commander, classification normal) and never
 *      auto-applies; applying is a separate `--apply` step driven by the
 *      `workspace.title.set.request` RPC.
 */

/** Description length cap, mirrored by the server-side description generator. */
export const DESCRIPTION_MAX_CHARS = 200;
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
}

export interface BackfillCandidate {
  agentId: string;
  name: string | null;
  title: string | null;
  shortDescription: string | null;
  cwd: string;
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
 * An agent needs the backfill when it misses at least one identity field and
 * is not machinery or archived. Mission-control-labeled agents (Commander,
 * Verifier, future monitors) are invisible to the fleet and never renamed.
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
  return !hasFullIdentity(agent);
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
}): string {
  const { hostLabel, namingTheme, candidates } = input;
  const lines = candidates.map(
    (candidate, index) =>
      `${index + 1}. agentId=${candidate.agentId}${candidate.title ? ` | current title: ${candidate.title}` : ""} | cwd: ${candidate.cwd || "(unknown)"}`,
  );
  return [
    "You are the naming pass of a one-time fleet identity backfill for the Mission Control board.",
    `Host: ${hostLabel}.`,
    "",
    `Naming theme: "${namingTheme}". Choose the agent's name (the short identity chip) to fit this theme; keep names short, fun, and unique across the fleet.`,
    "",
    "For each agent below produce exactly three fields:",
    '- "name": short identity chip fitting the theme (1-2 words). If the agent already has a name, KEEP IT UNCHANGED and still echo it back.',
    '- "title": a concise task title (max 8 words, plain language) describing what the agent is working on.',
    '- "description": one living sentence (max 200 chars, present tense, no markdown) describing what the agent is doing.',
    "",
    "Use the current title and cwd as the only source material. Never invent agentIds. Never include secrets or raw file contents.",
    "",
    "Reply with ONLY a JSON object, no prose, no code fences:",
    '{"agents":[{"agentId":"...","name":"...","title":"...","description":"..."}]}',
    "",
    "Agents:",
    ...lines,
  ].join("\n");
}

/** Wire shape of the one-shot's bulk JSON response. */
export const BackfillResponseSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.string().min(1),
      name: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
});

export type BackfillAgentResponse = z.infer<typeof BackfillResponseSchema>["agents"][number];

/**
 * Tolerant parse of the one-shot stdout: strips fenced blocks and leading
 * noise (omp prints "Working..."), extracts the first balanced {...} JSON
 * object, and validates it against {@link BackfillResponseSchema}. Returns
 * null when no valid payload is found.
 */
export function parseBackfillResponse(output: string): BackfillAgentResponse[] | null {
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
  return result.data.agents;
}

export interface BackfillIdentityUpdate {
  agentId: string;
  name?: string;
  title?: string;
  shortDescription?: string;
}

/**
 * Fold the one-shot's responses into per-agent updates, filling ONLY fields
 * the candidate still misses and the response actually provides. This is the
 * apply-time idempotency filter: a completed agent is never touched, and a
 * response that repeats an existing value is a no-op.
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
    if (title && !candidate.title) {
      update.title = title;
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

export interface WorkspaceBackfillInput {
  workspaceId: string;
  name: string;
  title?: string | null;
}

export interface WorkspaceRenameProposal {
  workspaceId: string;
  oldName: string;
  newName: string;
}

/** Common branch prefixes — the derived name is a branch slug, not a real title. */
const BRANCH_PREFIX_RE =
  /^(feat|feature|fix|bugfix|hotfix|chore|docs|refactor|refactoring|test|tests|style|perf|build|ci|wip|release|dependabot)[/-]/i;

const SLUG_SEPARATOR_RE = /[-_/.]/;

const DEFAULT_BRANCH_NAMES: Record<string, true> = {
  main: true,
  master: true,
  develop: true,
  dev: true,
};

/**
 * A workspace title is a derived default (branch/dir slug) when it is unset
 * or when the user-set title equals the derived name itself — either way the
 * title carries no information beyond the slug.
 */
export function isDerivedWorkspaceTitle(workspace: WorkspaceBackfillInput): boolean {
  const title = workspace.title?.trim();
  if (!title) {
    return true;
  }
  return title === workspace.name.trim();
}

/**
 * The derived name must actually look like a slug to be worth renaming: it
 * contains slug separators or a branch prefix, and is not a default branch
 * name or a too-short string.
 */
export function isSlugLikeDerivedName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return false;
  }
  // A real branch/dir slug never contains whitespace — sentence-like derived
  // names (generated from an agent's first prompt) are not rename targets.
  if (/\s/.test(trimmed)) {
    return false;
  }
  if (DEFAULT_BRANCH_NAMES[trimmed.toLowerCase()]) {
    return false;
  }
  return SLUG_SEPARATOR_RE.test(trimmed) || BRANCH_PREFIX_RE.test(trimmed);
}

/**
 * Deterministic old→new proposal from a branch/dir slug: strip the branch
 * prefix, split on separators, capitalize each word, join with spaces, cap at
 * 5 words. Returns null when the name is not a proposal candidate or the
 * result is a no-op.
 */
export function proposalTitleFromSlug(name: string): string | null {
  const trimmed = name.trim();
  if (!isSlugLikeDerivedName(trimmed)) {
    return null;
  }
  const slug = trimmed.replace(BRANCH_PREFIX_RE, "");
  const words = slug
    .split(/[-_/.]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, WORKSPACE_PROPOSAL_MAX_WORDS);
  if (words.length === 0) {
    return null;
  }
  const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  if (title === trimmed) {
    return null;
  }
  return title;
}

/** All rename proposals for a host's workspaces. Never auto-applied. */
export function buildWorkspaceRenameProposals(
  workspaces: readonly WorkspaceBackfillInput[],
): WorkspaceRenameProposal[] {
  const proposals: WorkspaceRenameProposal[] = [];
  for (const workspace of workspaces) {
    if (!isDerivedWorkspaceTitle(workspace)) {
      continue;
    }
    const newName = proposalTitleFromSlug(workspace.name);
    if (!newName) {
      continue;
    }
    proposals.push({ workspaceId: workspace.workspaceId, oldName: workspace.name, newName });
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
