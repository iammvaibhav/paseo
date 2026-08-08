import {
  ROLLUP_RUNS_PER_PROJECT,
  ROLLUP_RUNS_PER_WORKSPACE,
  type MissionControlRunOutcome,
  type MissionControlRunRecord,
} from "./run-records.js";

/**
 * M6 context architecture: workspace and project rollups derived from run
 * records — pure functions, no I/O. A workspace rollup is the living state of
 * a feature (what ran, what was decided, what's open); a project rollup is
 * the same across the project's workspaces. Rollups are cached in memory and
 * recomputed when a new run record lands (RollupCache).
 */

export interface RunRollupEntry {
  agentId: string;
  agentName: string;
  endedAt: string;
  outcome: MissionControlRunOutcome;
  /** First line of the launch brief, truncated for the block. */
  brief: string | null;
  /** Decision-kind self-reports: what this agent decided. */
  decisions: string[];
  /** Open items: blocked/diverged self-reports, failed runs, pending verdicts. */
  open: string[];
  /** Verdict summary, when the run was reviewed. */
  verdict: string | null;
}

export interface WorkspaceRollup {
  kind: "workspace";
  workspaceId: string;
  workspaceTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Latest run record considered. */
  updatedAt: string;
  /** Latest-first, capped at ROLLUP_RUNS_PER_WORKSPACE. */
  runs: RunRollupEntry[];
}

export interface ProjectRollup {
  kind: "project";
  projectId: string;
  projectName: string | null;
  updatedAt: string;
  /** Latest-first, capped at ROLLUP_RUNS_PER_PROJECT. */
  runs: RunRollupEntry[];
}

export type RunRollup = WorkspaceRollup | ProjectRollup;

const OPEN_REPORT_KINDS: Record<string, boolean> = {
  blocked: true,
  diverged: true,
};

/** Deterministic per-run rollup entry (what ran / decided / is open). */
export function deriveRunRollupEntry(record: MissionControlRunRecord): RunRollupEntry {
  const decisions: string[] = [];
  const open: string[] = [];
  for (const report of record.reports) {
    if (report.reportKind === "decision") {
      decisions.push(report.headline);
    } else if (OPEN_REPORT_KINDS[report.kind]) {
      open.push(report.headline);
    }
  }
  if (record.outcome === "failed" && !open.includes("run failed")) {
    open.push("run failed");
  }
  if (record.outcome === "interrupted" && !open.includes("run interrupted")) {
    open.push("run interrupted");
  }
  const awaitingReview =
    (record.outcome === "finished" || record.outcome === "ready") && record.verdict === null;
  if (awaitingReview && !open.includes("awaiting verdict")) {
    open.push("awaiting verdict");
  }
  return {
    agentId: record.agentId,
    agentName: record.agentName,
    endedAt: record.endedAt,
    outcome: record.outcome,
    brief: record.brief ? record.brief.split("\n")[0].trim() : null,
    decisions: decisions.slice(0, 3),
    open: open.slice(0, 3),
    verdict: record.verdict?.summary ?? null,
  };
}

function latestFirst(records: MissionControlRunRecord[]): MissionControlRunRecord[] {
  return [...records].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
}

/**
 * Workspace rollup: latest run records for agents in that workspace. Returns
 * null when the workspace has no run records yet.
 */
export function deriveWorkspaceRollup(
  records: MissionControlRunRecord[],
  workspaceId: string,
  limit: number = ROLLUP_RUNS_PER_WORKSPACE,
): WorkspaceRollup | null {
  const inWorkspace = latestFirst(
    records.filter((record) => record.workspaceId === workspaceId),
  ).slice(0, limit);
  if (inWorkspace.length === 0) {
    return null;
  }
  const newest = inWorkspace[0];
  return {
    kind: "workspace",
    workspaceId,
    workspaceTitle: newest.workspaceTitle ?? null,
    projectId: newest.projectId ?? null,
    projectName: newest.projectName ?? null,
    updatedAt: newest.updatedAt,
    runs: inWorkspace.map(deriveRunRollupEntry),
  };
}

/**
 * Project rollup: same derivation across every workspace in the project.
 * Returns null when the project has no run records yet.
 */
export function deriveProjectRollup(
  records: MissionControlRunRecord[],
  projectId: string,
  limit: number = ROLLUP_RUNS_PER_PROJECT,
): ProjectRollup | null {
  const inProject = latestFirst(records.filter((record) => record.projectId === projectId)).slice(
    0,
    limit,
  );
  if (inProject.length === 0) {
    return null;
  }
  return {
    kind: "project",
    projectId,
    projectName: inProject[0].projectName ?? null,
    updatedAt: inProject[0].updatedAt,
    runs: inProject.map(deriveRunRollupEntry),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  // Reserve 3 bytes for the ellipsis so the result never exceeds maxBytes.
  const budget = Math.max(1, maxBytes - 3);
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > budget) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function entryBlock(entry: RunRollupEntry, maxBytes: number): string {
  const lines = [
    `- ${entry.agentName} (${entry.endedAt.slice(0, 10)}, ${entry.outcome}): ${entry.brief ?? "(no launch brief)"}`,
  ];
  if (entry.decisions.length > 0) {
    lines.push(`  decided: ${entry.decisions.join("; ")}`);
  }
  if (entry.open.length > 0) {
    lines.push(`  open: ${entry.open.join("; ")}`);
  }
  if (entry.verdict) {
    lines.push(`  verdict: ${entry.verdict}`);
  }
  return truncateUtf8(lines.join("\n"), maxBytes);
}

/**
 * The markdown block appended to a new agent's initial prompt when its
 * workspace has prior work. Bounded to maxBytes (default ~2KB); newest
 * entries win, older ones drop when the budget runs out. Returns null when
 * there is nothing to include.
 */
export function buildPriorWorkBlock(
  rollup: WorkspaceRollup | ProjectRollup,
  maxBytes: number = 2048,
): string | null {
  if (rollup.runs.length === 0) {
    return null;
  }
  const heading =
    rollup.kind === "workspace"
      ? `# Prior work in this workspace\n${rollup.workspaceTitle ?? rollup.workspaceId}`
      : `# Prior work in this project\n${rollup.projectName ?? rollup.projectId}`;
  const header = `${heading}\n(what ran, what was decided, what's open — newest first)`;
  let remaining = maxBytes - Buffer.byteLength(header, "utf8") - 1;
  const blocks: string[] = [];
  for (const entry of rollup.runs) {
    if (remaining < 80) {
      break; // no room for a meaningful entry; newest entries already included
    }
    const block = entryBlock(entry, remaining);
    blocks.push(block);
    remaining -= Buffer.byteLength(block, "utf8") + 1;
  }
  if (blocks.length === 0) {
    return null;
  }
  return `${header}\n${blocks.join("\n")}`;
}

/**
 * Append the prior-work block to a spawn prompt (the spawn plan application
 * point calls this so both ask and auto paths enrich at execution time).
 * Returns the original prompt when there is no prior work to include.
 */
export function appendPriorWorkBlock(
  prompt: string | undefined,
  rollup: WorkspaceRollup | ProjectRollup,
  maxBytes: number = 2048,
): string | undefined {
  const block = buildPriorWorkBlock(rollup, maxBytes);
  if (!block) {
    return prompt;
  }
  const base = prompt?.trim();
  return base ? `${base}\n\n${block}` : block;
}

/**
 * In-memory rollup cache: recomputed lazily and invalidated when a new run
 * record lands. Sized by the number of workspaces/projects that get looked
 * up (bounded by fleet size, well under any memory concern).
 */
export class RollupCache {
  private readonly workspace = new Map<string, WorkspaceRollup>();
  private readonly project = new Map<string, ProjectRollup>();

  invalidate(): void {
    this.workspace.clear();
    this.project.clear();
  }

  getWorkspace(workspaceId: string, compute: () => WorkspaceRollup | null): WorkspaceRollup | null {
    const cached = this.workspace.get(workspaceId);
    if (cached !== undefined) {
      return cached;
    }
    const derived = compute();
    if (derived) {
      this.workspace.set(workspaceId, derived);
    }
    return derived;
  }

  getProject(projectId: string, compute: () => ProjectRollup | null): ProjectRollup | null {
    const cached = this.project.get(projectId);
    if (cached !== undefined) {
      return cached;
    }
    const derived = compute();
    if (derived) {
      this.project.set(projectId, derived);
    }
    return derived;
  }
}
