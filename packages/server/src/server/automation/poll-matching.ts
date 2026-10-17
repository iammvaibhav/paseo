import { z } from "zod";

// Pure matching + event-key helpers for poll automations (GitHub/Linear).
// MonoCode equivalents: automationEvents.ts (matchInboxAutomations,
// automationEventKey, triggerMatchesInboxItem) and automations.rs
// (INSERT OR IGNORE claims).

export const GITHUB_POLL_EVENTS = [
  "pull_request_opened",
  "draft_opened",
  "issue_opened",
  "labelled",
] as const;
export type GithubPollEventName = (typeof GITHUB_POLL_EVENTS)[number];

export const LINEAR_POLL_EVENTS = ["issue_created", "assigned"] as const;
export type LinearPollEventName = (typeof LINEAR_POLL_EVENTS)[number];

export interface PollFilter {
  repos: string[];
  events: string[];
  labels: string[];
  actors: string[];
}

export interface GithubPollItem {
  kind: "pr" | "issue";
  number: number;
  title: string;
  url: string;
  body: string | null;
  labels: string[];
  author: string;
  draft: boolean;
  updatedAt: string;
}

export interface LinearPollItem {
  id: string;
  identifier: string;
  title: string;
  url: string;
  body: string | null;
  labels: string[];
  author: string;
  assignees: string[];
  teamKey: string;
  teamName: string;
  updatedAt: string;
}

export function normalizeRepoList(repos: readonly string[] | undefined): string[] {
  return (repos ?? []).map((repo) => repo.trim().toLowerCase()).filter((repo) => repo.length > 0);
}

export function normalizeStringList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

export function normalizeActorList(actors: readonly string[] | undefined): string[] {
  return normalizeStringList(actors).map((actor) => actor.toLowerCase());
}

function sanitizeEventKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_\-./]/g, "_")
    .slice(0, 400);
}

export function githubEventKey(input: {
  kind: "pr" | "issue";
  repo: string;
  number: number;
  label?: string;
}): string {
  const base = sanitizeEventKeyPart(`github:${input.kind}:${input.repo}:${input.number}`);
  return input.label ? `${base}:labelled:${sanitizeEventKeyPart(input.label)}` : base;
}

export function linearEventKey(input: { id: string; assignee?: string }): string {
  const base = sanitizeEventKeyPart(`linear:issue:${input.id}`);
  return input.assignee ? `${base}:assigned:${sanitizeEventKeyPart(input.assignee)}` : base;
}

export function githubAppearedEvent(
  item: GithubPollItem,
): "pull_request_opened" | "draft_opened" | "issue_opened" {
  if (item.kind === "pr") {
    return item.draft ? "draft_opened" : "pull_request_opened";
  }
  return "issue_opened";
}

function matchesRepos(repos: readonly string[], repo: string): boolean {
  if (repos.length === 0) return true;
  return repos.includes(repo.trim().toLowerCase());
}

/** Actor filter: empty (or "anyone") matches every author. */
function matchesActor(actors: readonly string[], author: string): boolean {
  const normalized = actors.map((actor) => actor.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0 || normalized.includes("anyone")) return true;
  return normalized.includes(author.trim().toLowerCase());
}

function matchesLabels(required: readonly string[], present: readonly string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(present.map((label) => label.trim().toLowerCase()));
  return required.every((label) => have.has(label.trim().toLowerCase()));
}

export function matchGithubItem(
  filter: PollFilter,
  repo: string,
  item: GithubPollItem,
): { event: string; eventKeys: string[] } | null {
  const appeared = githubAppearedEvent(item);
  const events = new Set(filter.events);
  const matched: string[] = [];
  const keys: string[] = [];
  if (events.has(appeared)) {
    matched.push(appeared);
    keys.push(githubEventKey({ kind: item.kind, repo, number: item.number }));
  }
  if (events.has("labelled") && item.labels.length > 0) {
    for (const label of item.labels) {
      matched.push("labelled");
      keys.push(githubEventKey({ kind: item.kind, repo, number: item.number, label }));
    }
  }
  const first = matched[0];
  if (first === undefined) return null;
  if (!matchesRepos(filter.repos, repo)) return null;
  if (!matchesActor(filter.actors, item.author)) return null;
  if (!matchesLabels(filter.labels, item.labels)) return null;
  return { event: first, eventKeys: keys.filter((_, index) => matched[index] === first) };
}

export function matchLinearItem(
  filter: PollFilter,
  item: LinearPollItem,
): { event: string; eventKeys: string[] } | null {
  const events = new Set(filter.events);
  const matched: Array<{ event: string; key: string }> = [];
  if (events.has("issue_created")) {
    matched.push({ event: "issue_created", key: linearEventKey({ id: item.id }) });
  }
  if (events.has("assigned")) {
    for (const assignee of item.assignees) {
      matched.push({ event: "assigned", key: linearEventKey({ id: item.id, assignee }) });
    }
  }
  // `repos` matches the Linear team key or name; empty matches all teams.
  if (filter.repos.length > 0) {
    const teamKey = item.teamKey.trim().toLowerCase();
    const teamName = item.teamName.trim().toLowerCase();
    const wanted = filter.repos.map((repo) => repo.trim().toLowerCase());
    if (!wanted.some((repo) => repo === teamKey || repo === teamName)) return null;
  }
  if (!matchesLabels(filter.labels, item.labels)) return null;
  const head = matched[0];
  if (head === undefined) return null;
  const actors = filter.actors;
  const candidates = head.event === "assigned" ? item.assignees : [item.author, ...item.assignees];
  if (!candidates.some((candidate) => matchesActor(actors, candidate))) return null;
  return {
    event: head.event,
    eventKeys: matched.filter((m) => m.event === head.event).map((m) => m.key),
  };
}

export function buildEventDraft(input: {
  provider: "github" | "linear";
  title: string;
  url: string;
  author: string;
  labels: string[];
  body: string | null;
  number?: number;
  identifier?: string;
}): string {
  const lines = [
    `Source: ${input.provider}`,
    `Title: ${input.title}`,
    `URL: ${input.url}`,
    `Author: ${input.author || "unknown"}`,
  ];
  if (input.number !== undefined) lines.push(`Number: ${input.number}`);
  if (input.identifier) lines.push(`Identifier: ${input.identifier}`);
  if (input.labels.length > 0) lines.push(`Labels: ${input.labels.join(", ")}`);
  const body = (input.body ?? "").trim().slice(0, 4000);
  lines.push("", body || "(no description)");
  return lines.join("\n");
}

const PollStringListSchema = z.array(z.string()).optional();

export const PollConfigSchema = z.object({
  repos: PollStringListSchema,
  events: PollStringListSchema,
  labels: PollStringListSchema,
  actors: PollStringListSchema,
  pollIntervalSec: z.number().int().positive().optional(),
  token: z.string().min(1).nullable().optional(),
});
export type PollConfig = z.infer<typeof PollConfigSchema>;
