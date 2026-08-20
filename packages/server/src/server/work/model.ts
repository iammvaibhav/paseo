import { randomBytes } from "node:crypto";
import { z } from "zod";

export function generateWorkItemId(): string {
  return `wit_${randomBytes(8).toString("hex")}`;
}

export function generateWorkProjectId(): string {
  return `wkp_${randomBytes(8).toString("hex")}`;
}

export function generateWorkCommentId(): string {
  return `wcm_${randomBytes(8).toString("hex")}`;
}

export function generateWorkLabelId(): string {
  return `wlb_${randomBytes(8).toString("hex")}`;
}

export function generateWorkPageId(): string {
  return `wpg_${randomBytes(8).toString("hex")}`;
}

export function generateWorkDraftId(): string {
  return `wdr_${randomBytes(8).toString("hex")}`;
}

export function generateWorkStickyId(): string {
  return `wst_${randomBytes(8).toString("hex")}`;
}

export function generateWorkViewId(): string {
  return `wvw_${randomBytes(8).toString("hex")}`;
}

export const WorkLaneSchema = z.enum(["backlog", "todo"]);
export type WorkLane = z.infer<typeof WorkLaneSchema>;

export const WorkPrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export type WorkPriority = z.infer<typeof WorkPrioritySchema>;

export const WorkClosedStateSchema = z.enum(["done", "cancelled"]);
export type WorkClosedState = z.infer<typeof WorkClosedStateSchema>;

export const WorkIsolationSchema = z.enum(["worktree", "local"]);
export type WorkIsolation = z.infer<typeof WorkIsolationSchema>;

export const WorkAssignmentSchema = z.object({
  provider: z.string(),
  model: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  modeId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  thinkingOptionId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  host: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  workspaceId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  isolation: WorkIsolationSchema,
});

export type WorkAssignment = z.infer<typeof WorkAssignmentSchema>;

export const WorkItemRecordSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  projectId: z.string(),
  sequenceId: z.number(),
  title: z.string(),
  description: z.string(),
  priority: WorkPrioritySchema,
  labelIds: z.array(z.string()),
  parentId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  sortOrder: z.number(),
  lane: WorkLaneSchema,
  assignment: WorkAssignmentSchema.nullable()
    .optional()
    .transform((v) => v ?? null),
  agentId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  agentHost: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  closed: z
    .object({ state: WorkClosedStateSchema, at: z.string() })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkItemRecord = z.infer<typeof WorkItemRecordSchema>;

export const WorkProjectRecordSchema = z.object({
  projectKey: z.string(),
  projectId: z.string(),
  identifier: z.string(),
  displayName: z.string(),
  description: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  nextSequenceId: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

export type WorkProjectRecord = z.infer<typeof WorkProjectRecordSchema>;

export const WorkCommentRecordSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  projectKey: z.string(),
  body: z.string(),
  authorKind: z
    .enum(["user", "agent"])
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  authorId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  createdAt: z.string(),
});

export type WorkCommentRecord = z.infer<typeof WorkCommentRecordSchema>;

export const WorkActivityRecordSchema = z.object({
  id: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  itemId: z.string(),
  projectKey: z.string(),
  verb: z.string(),
  field: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  oldValue: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  newValue: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  actorKind: z
    .enum(["user", "agent", "system"])
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  actorId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  createdAt: z.string(),
});

export type WorkActivityRecord = z.infer<typeof WorkActivityRecordSchema>;

export const WorkLabelRecordSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  name: z.string(),
  color: z.string(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkLabelRecord = z.infer<typeof WorkLabelRecordSchema>;

export const WorkPageRecordSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  title: z.string(),
  content: z.string(),
  parentId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkPageRecord = z.infer<typeof WorkPageRecordSchema>;

export const WorkDraftRecordSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  projectId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  title: z.string(),
  description: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  priority: WorkPrioritySchema.nullable()
    .optional()
    .transform((v) => v ?? null),
  labelIds: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  parentId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  // Carried through promoteDraft so a drafted item keeps its agent choice.
  assignment: WorkAssignmentSchema.nullable()
    .optional()
    .transform((v) => v ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkDraftRecord = z.infer<typeof WorkDraftRecordSchema>;

export const WorkStickyRecordSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  content: z.string(),
  color: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkStickyRecord = z.infer<typeof WorkStickyRecordSchema>;

export const WorkViewRecordSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  name: z.string(),
  filters: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  groupBy: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  orderBy: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkViewRecord = z.infer<typeof WorkViewRecordSchema>;

/**
 * Derive identifier from display name: uppercase, strip non-alphanumerics,
 * truncated to 12 chars, uniquified with numeric suffix.
 */
export function deriveProjectIdentifier(displayName: string, taken: Set<string>): string {
  const base =
    displayName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12) || "WORK";
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (true) {
    const suffixStr = String(suffix);
    const prefix = base.slice(0, 12 - suffixStr.length);
    const candidate = `${prefix}${suffixStr}`;
    if (!taken.has(candidate)) return candidate;
    suffix += 1;
  }
}
