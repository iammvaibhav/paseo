import { z } from "zod";

import type { WorkColumnId, WorkItemLane } from "./state.js";

export const WorkPrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export type WorkPriority = z.infer<typeof WorkPrioritySchema>;

// `state.ts` owns both unions. `satisfies` keeps these wire schemas locked to
// it, so adding a column there fails here until the schema follows.
export const WorkItemLaneSchema = z.enum(["backlog", "todo"]) satisfies z.ZodType<WorkItemLane>;

export const WorkColumnIdSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "needs_me",
  "done",
]) satisfies z.ZodType<WorkColumnId>;

export const WorkClosedStateSchema = z.enum(["done", "cancelled"]);

export const LifecycleBucketSchema = z.enum(["needs_you", "running", "ready", "done", "idle"]);

export const WorkAssignmentSchema = z.object({
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  isolation: z.enum(["worktree", "local"]),
});
export type WorkAssignment = z.infer<typeof WorkAssignmentSchema>;

export const WorkProjectSchema = z.object({
  projectKey: z.string().min(1),
  projectId: z.string().min(1),
  identifier: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable().optional(),
  nextSequenceId: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().optional(),
});
export type WorkProject = z.infer<typeof WorkProjectSchema>;

export const WorkItemSchema = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  projectId: z.string().min(1),
  sequenceId: z.number().int().nonnegative(),
  humanKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  priority: WorkPrioritySchema,
  labelIds: z.array(z.string()),
  parentId: z.string().nullable(),
  sortOrder: z.number(),
  lane: WorkItemLaneSchema,
  assignment: WorkAssignmentSchema.nullable(),
  agentId: z.string().nullable(),
  agentHost: z.string().nullable(),
  closed: z
    .object({
      state: WorkClosedStateSchema,
      at: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  column: z.union([WorkColumnIdSchema, z.literal("cancelled")]),
  bucket: LifecycleBucketSchema.nullable(),
  subItemCount: z.number().int().nonnegative().optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WorkCommentSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  body: z.string(),
  authorKind: z.enum(["user", "agent"]),
  authorId: z.string().nullable().optional(),
  authorName: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type WorkComment = z.infer<typeof WorkCommentSchema>;

export const WorkActivitySchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  verb: z.string().min(1),
  field: z.string().nullable().optional(),
  oldValue: z.string().nullable().optional(),
  newValue: z.string().nullable().optional(),
  actorKind: z.enum(["user", "agent", "system"]),
  actorId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type WorkActivity = z.infer<typeof WorkActivitySchema>;

export const WorkLabelSchema = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  sortOrder: z.number(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkLabel = z.infer<typeof WorkLabelSchema>;

export const WorkPageSchema = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkPage = z.infer<typeof WorkPageSchema>;

export const WorkDraftSchema = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: WorkPrioritySchema.optional(),
  labelIds: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  assignment: WorkAssignmentSchema.nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkDraft = z.infer<typeof WorkDraftSchema>;

export const WorkStickySchema = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  body: z.string().min(1),
  color: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkSticky = z.infer<typeof WorkStickySchema>;

export const WorkViewSchema = z.object({
  id: z.string().min(1),
  projectKey: z.string().min(1),
  name: z.string().min(1),
  filters: z.record(z.string(), z.unknown()).nullable().optional(),
  groupBy: z.string().nullable().optional(),
  orderBy: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkView = z.infer<typeof WorkViewSchema>;

export const WorkItemDetailSchema = z.object({
  item: WorkItemSchema,
  comments: z.array(WorkCommentSchema),
  activity: z.array(WorkActivitySchema),
  subItems: z.array(WorkItemSchema),
});
export type WorkItemDetail = z.infer<typeof WorkItemDetailSchema>;

// Per-host fleet wrappers — copy unreachable-peer representation from mission control context fetch:
// reachable:false with empty rows, never throw.
export const WorkProjectHostEntrySchema = z.object({
  host: z.string().min(1),
  reachable: z.boolean(),
  projects: z.array(WorkProjectSchema),
});
export type WorkProjectHostEntry = z.infer<typeof WorkProjectHostEntrySchema>;

export const WorkItemHostEntrySchema = z.object({
  host: z.string().min(1),
  reachable: z.boolean(),
  items: z.array(WorkItemSchema),
});
export type WorkItemHostEntry = z.infer<typeof WorkItemHostEntrySchema>;

// ---------------------------------------------------------------------------
// RPC: work.project.list
// ---------------------------------------------------------------------------
export const WorkProjectListRequestSchema = z.object({
  type: z.literal("work.project.list.request"),
  requestId: z.string(),
});
export type WorkProjectListRequest = z.infer<typeof WorkProjectListRequestSchema>;

export const WorkProjectListResponseSchema = z.object({
  type: z.literal("work.project.list.response"),
  payload: z.object({
    requestId: z.string(),
    hosts: z.array(WorkProjectHostEntrySchema),
  }),
});
export type WorkProjectListResponse = z.infer<typeof WorkProjectListResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.list
// ---------------------------------------------------------------------------
export const WorkItemListRequestSchema = z.object({
  type: z.literal("work.item.list.request"),
  projectKey: z.string().min(1),
  requestId: z.string(),
});
export type WorkItemListRequest = z.infer<typeof WorkItemListRequestSchema>;

export const WorkItemListResponseSchema = z.object({
  type: z.literal("work.item.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectKey: z.string().min(1),
    hosts: z.array(WorkItemHostEntrySchema),
  }),
});
export type WorkItemListResponse = z.infer<typeof WorkItemListResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.get
// ---------------------------------------------------------------------------
export const WorkItemGetRequestSchema = z.object({
  type: z.literal("work.item.get.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkItemGetRequest = z.infer<typeof WorkItemGetRequestSchema>;

export const WorkItemGetResponseSchema = z.object({
  type: z.literal("work.item.get.response"),
  payload: z.object({
    requestId: z.string(),
    detail: WorkItemDetailSchema.nullable(),
  }),
});
export type WorkItemGetResponse = z.infer<typeof WorkItemGetResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.create
// ---------------------------------------------------------------------------
export const WorkItemCreateRequestSchema = z.object({
  type: z.literal("work.item.create.request"),
  projectKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: WorkPrioritySchema.optional(),
  labelIds: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  lane: WorkItemLaneSchema.optional(),
  assignment: WorkAssignmentSchema.nullable().optional(),
  sortOrder: z.number().optional(),
  requestId: z.string(),
});
export type WorkItemCreateRequest = z.infer<typeof WorkItemCreateRequestSchema>;

export const WorkItemCreateResponseSchema = z.object({
  type: z.literal("work.item.create.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkItemSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkItemCreateResponse = z.infer<typeof WorkItemCreateResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.update
// ---------------------------------------------------------------------------
export const WorkItemUpdateRequestSchema = z.object({
  type: z.literal("work.item.update.request"),
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: WorkPrioritySchema.optional(),
  labelIds: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  assignment: WorkAssignmentSchema.nullable().optional(),
  lane: WorkItemLaneSchema.optional(),
  requestId: z.string(),
});
export type WorkItemUpdateRequest = z.infer<typeof WorkItemUpdateRequestSchema>;

export const WorkItemUpdateResponseSchema = z.object({
  type: z.literal("work.item.update.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkItemSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkItemUpdateResponse = z.infer<typeof WorkItemUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.delete
// ---------------------------------------------------------------------------
export const WorkItemDeleteRequestSchema = z.object({
  type: z.literal("work.item.delete.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkItemDeleteRequest = z.infer<typeof WorkItemDeleteRequestSchema>;

export const WorkItemDeleteResponseSchema = z.object({
  type: z.literal("work.item.delete.response"),
  payload: z.object({
    requestId: z.string(),
    success: z.boolean(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkItemDeleteResponse = z.infer<typeof WorkItemDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.move
// ---------------------------------------------------------------------------
export const WorkItemMoveRequestSchema = z.object({
  type: z.literal("work.item.move.request"),
  id: z.string().min(1),
  targetColumn: z.union([WorkColumnIdSchema, z.literal("cancelled")]),
  sortOrder: z.number().optional(),
  requestId: z.string(),
});
export type WorkItemMoveRequest = z.infer<typeof WorkItemMoveRequestSchema>;

export const WorkItemMoveResponseSchema = z.object({
  type: z.literal("work.item.move.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkItemSchema.nullable(),
    rebalanced: z.array(WorkItemSchema).optional(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkItemMoveResponse = z.infer<typeof WorkItemMoveResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.item.dispatch
// ---------------------------------------------------------------------------
export const WorkItemDispatchRequestSchema = z.object({
  type: z.literal("work.item.dispatch.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkItemDispatchRequest = z.infer<typeof WorkItemDispatchRequestSchema>;

export const WorkItemDispatchResponseSchema = z.object({
  type: z.literal("work.item.dispatch.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkItemSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkItemDispatchResponse = z.infer<typeof WorkItemDispatchResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.comment.list / work.comment.create
// ---------------------------------------------------------------------------
export const WorkCommentListRequestSchema = z.object({
  type: z.literal("work.comment.list.request"),
  itemId: z.string().min(1),
  requestId: z.string(),
});
export type WorkCommentListRequest = z.infer<typeof WorkCommentListRequestSchema>;

export const WorkCommentListResponseSchema = z.object({
  type: z.literal("work.comment.list.response"),
  payload: z.object({
    requestId: z.string(),
    itemId: z.string().min(1),
    comments: z.array(WorkCommentSchema),
  }),
});
export type WorkCommentListResponse = z.infer<typeof WorkCommentListResponseSchema>;

export const WorkCommentCreateRequestSchema = z.object({
  type: z.literal("work.comment.create.request"),
  itemId: z.string().min(1),
  body: z.string().min(1),
  requestId: z.string(),
});
export type WorkCommentCreateRequest = z.infer<typeof WorkCommentCreateRequestSchema>;

export const WorkCommentCreateResponseSchema = z.object({
  type: z.literal("work.comment.create.response"),
  payload: z.object({
    requestId: z.string(),
    comment: WorkCommentSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkCommentCreateResponse = z.infer<typeof WorkCommentCreateResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.activity.list
// ---------------------------------------------------------------------------
export const WorkActivityListRequestSchema = z.object({
  type: z.literal("work.activity.list.request"),
  itemId: z.string().min(1),
  requestId: z.string(),
});
export type WorkActivityListRequest = z.infer<typeof WorkActivityListRequestSchema>;

export const WorkActivityListResponseSchema = z.object({
  type: z.literal("work.activity.list.response"),
  payload: z.object({
    requestId: z.string(),
    itemId: z.string().min(1),
    activity: z.array(WorkActivitySchema),
  }),
});
export type WorkActivityListResponse = z.infer<typeof WorkActivityListResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.label.list / upsert / delete
// ---------------------------------------------------------------------------
export const WorkLabelListRequestSchema = z.object({
  type: z.literal("work.label.list.request"),
  projectKey: z.string().min(1),
  requestId: z.string(),
});
export type WorkLabelListRequest = z.infer<typeof WorkLabelListRequestSchema>;

export const WorkLabelListResponseSchema = z.object({
  type: z.literal("work.label.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectKey: z.string().min(1),
    labels: z.array(WorkLabelSchema),
  }),
});
export type WorkLabelListResponse = z.infer<typeof WorkLabelListResponseSchema>;

export const WorkLabelUpsertRequestSchema = z.object({
  type: z.literal("work.label.upsert.request"),
  projectKey: z.string().min(1),
  label: WorkLabelSchema.partial().extend({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    color: z.string().min(1),
  }),
  requestId: z.string(),
});
export type WorkLabelUpsertRequest = z.infer<typeof WorkLabelUpsertRequestSchema>;

export const WorkLabelUpsertResponseSchema = z.object({
  type: z.literal("work.label.upsert.response"),
  payload: z.object({
    requestId: z.string(),
    label: WorkLabelSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkLabelUpsertResponse = z.infer<typeof WorkLabelUpsertResponseSchema>;

export const WorkLabelDeleteRequestSchema = z.object({
  type: z.literal("work.label.delete.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkLabelDeleteRequest = z.infer<typeof WorkLabelDeleteRequestSchema>;

export const WorkLabelDeleteResponseSchema = z.object({
  type: z.literal("work.label.delete.response"),
  payload: z.object({
    requestId: z.string(),
    success: z.boolean(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkLabelDeleteResponse = z.infer<typeof WorkLabelDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.page.list / get / upsert / delete
// ---------------------------------------------------------------------------
export const WorkPageListRequestSchema = z.object({
  type: z.literal("work.page.list.request"),
  projectKey: z.string().min(1),
  requestId: z.string(),
});
export type WorkPageListRequest = z.infer<typeof WorkPageListRequestSchema>;

export const WorkPageListResponseSchema = z.object({
  type: z.literal("work.page.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectKey: z.string().min(1),
    pages: z.array(WorkPageSchema),
  }),
});
export type WorkPageListResponse = z.infer<typeof WorkPageListResponseSchema>;

export const WorkPageGetRequestSchema = z.object({
  type: z.literal("work.page.get.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkPageGetRequest = z.infer<typeof WorkPageGetRequestSchema>;

export const WorkPageGetResponseSchema = z.object({
  type: z.literal("work.page.get.response"),
  payload: z.object({
    requestId: z.string(),
    page: WorkPageSchema.nullable(),
  }),
});
export type WorkPageGetResponse = z.infer<typeof WorkPageGetResponseSchema>;

export const WorkPageUpsertRequestSchema = z.object({
  type: z.literal("work.page.upsert.request"),
  projectKey: z.string().min(1),
  page: WorkPageSchema.partial().extend({
    id: z.string().min(1).optional(),
    title: z.string().min(1),
    body: z.string(),
  }),
  requestId: z.string(),
});
export type WorkPageUpsertRequest = z.infer<typeof WorkPageUpsertRequestSchema>;

export const WorkPageUpsertResponseSchema = z.object({
  type: z.literal("work.page.upsert.response"),
  payload: z.object({
    requestId: z.string(),
    page: WorkPageSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkPageUpsertResponse = z.infer<typeof WorkPageUpsertResponseSchema>;

export const WorkPageDeleteRequestSchema = z.object({
  type: z.literal("work.page.delete.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkPageDeleteRequest = z.infer<typeof WorkPageDeleteRequestSchema>;

export const WorkPageDeleteResponseSchema = z.object({
  type: z.literal("work.page.delete.response"),
  payload: z.object({
    requestId: z.string(),
    success: z.boolean(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkPageDeleteResponse = z.infer<typeof WorkPageDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.draft.list / create / promote
// ---------------------------------------------------------------------------
export const WorkDraftListRequestSchema = z.object({
  type: z.literal("work.draft.list.request"),
  projectKey: z.string().min(1),
  requestId: z.string(),
});
export type WorkDraftListRequest = z.infer<typeof WorkDraftListRequestSchema>;

export const WorkDraftListResponseSchema = z.object({
  type: z.literal("work.draft.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectKey: z.string().min(1),
    drafts: z.array(WorkDraftSchema),
  }),
});
export type WorkDraftListResponse = z.infer<typeof WorkDraftListResponseSchema>;

export const WorkDraftCreateRequestSchema = z.object({
  type: z.literal("work.draft.create.request"),
  projectKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: WorkPrioritySchema.optional(),
  labelIds: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  assignment: WorkAssignmentSchema.nullable().optional(),
  requestId: z.string(),
});
export type WorkDraftCreateRequest = z.infer<typeof WorkDraftCreateRequestSchema>;

export const WorkDraftCreateResponseSchema = z.object({
  type: z.literal("work.draft.create.response"),
  payload: z.object({
    requestId: z.string(),
    draft: WorkDraftSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkDraftCreateResponse = z.infer<typeof WorkDraftCreateResponseSchema>;

export const WorkDraftPromoteRequestSchema = z.object({
  type: z.literal("work.draft.promote.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkDraftPromoteRequest = z.infer<typeof WorkDraftPromoteRequestSchema>;

export const WorkDraftPromoteResponseSchema = z.object({
  type: z.literal("work.draft.promote.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkItemSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkDraftPromoteResponse = z.infer<typeof WorkDraftPromoteResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.sticky.list / upsert / delete
// ---------------------------------------------------------------------------
export const WorkStickyListRequestSchema = z.object({
  type: z.literal("work.sticky.list.request"),
  projectKey: z.string().min(1),
  requestId: z.string(),
});
export type WorkStickyListRequest = z.infer<typeof WorkStickyListRequestSchema>;

export const WorkStickyListResponseSchema = z.object({
  type: z.literal("work.sticky.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectKey: z.string().min(1),
    stickies: z.array(WorkStickySchema),
  }),
});
export type WorkStickyListResponse = z.infer<typeof WorkStickyListResponseSchema>;

export const WorkStickyUpsertRequestSchema = z.object({
  type: z.literal("work.sticky.upsert.request"),
  projectKey: z.string().min(1),
  sticky: WorkStickySchema.partial().extend({
    id: z.string().min(1).optional(),
    body: z.string().min(1),
  }),
  requestId: z.string(),
});
export type WorkStickyUpsertRequest = z.infer<typeof WorkStickyUpsertRequestSchema>;

export const WorkStickyUpsertResponseSchema = z.object({
  type: z.literal("work.sticky.upsert.response"),
  payload: z.object({
    requestId: z.string(),
    sticky: WorkStickySchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkStickyUpsertResponse = z.infer<typeof WorkStickyUpsertResponseSchema>;

export const WorkStickyDeleteRequestSchema = z.object({
  type: z.literal("work.sticky.delete.request"),
  id: z.string().min(1),
  requestId: z.string(),
});
export type WorkStickyDeleteRequest = z.infer<typeof WorkStickyDeleteRequestSchema>;

export const WorkStickyDeleteResponseSchema = z.object({
  type: z.literal("work.sticky.delete.response"),
  payload: z.object({
    requestId: z.string(),
    success: z.boolean(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkStickyDeleteResponse = z.infer<typeof WorkStickyDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// RPC: work.view.list / upsert
// ---------------------------------------------------------------------------
export const WorkViewListRequestSchema = z.object({
  type: z.literal("work.view.list.request"),
  projectKey: z.string().min(1),
  requestId: z.string(),
});
export type WorkViewListRequest = z.infer<typeof WorkViewListRequestSchema>;

export const WorkViewListResponseSchema = z.object({
  type: z.literal("work.view.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectKey: z.string().min(1),
    views: z.array(WorkViewSchema),
  }),
});
export type WorkViewListResponse = z.infer<typeof WorkViewListResponseSchema>;

export const WorkViewUpsertRequestSchema = z.object({
  type: z.literal("work.view.upsert.request"),
  projectKey: z.string().min(1),
  view: WorkViewSchema.partial().extend({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
  }),
  requestId: z.string(),
});
export type WorkViewUpsertRequest = z.infer<typeof WorkViewUpsertRequestSchema>;

export const WorkViewUpsertResponseSchema = z.object({
  type: z.literal("work.view.upsert.response"),
  payload: z.object({
    requestId: z.string(),
    view: WorkViewSchema.nullable(),
    error: z.string().nullable().optional(),
  }),
});
export type WorkViewUpsertResponse = z.infer<typeof WorkViewUpsertResponseSchema>;

// ---------------------------------------------------------------------------
// Push messages: work.item.updated + work.project.updated
// ---------------------------------------------------------------------------
export const WorkItemUpdatedMessageSchema = z.object({
  type: z.literal("work.item.updated"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      item: WorkItemSchema,
    }),
    z.object({
      kind: z.literal("remove"),
      itemId: z.string().min(1),
      projectKey: z.string().min(1),
    }),
  ]),
});
export type WorkItemUpdatedMessage = z.infer<typeof WorkItemUpdatedMessageSchema>;

export const WorkProjectUpdatedMessageSchema = z.object({
  type: z.literal("work.project.updated"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      project: WorkProjectSchema,
    }),
    z.object({
      kind: z.literal("remove"),
      projectKey: z.string().min(1),
    }),
  ]),
});
export type WorkProjectUpdatedMessage = z.infer<typeof WorkProjectUpdatedMessageSchema>;
