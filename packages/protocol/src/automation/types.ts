import { z } from "zod";
import { ScheduleCadenceSchema, ScheduleStatusSchema } from "../schedule/types.js";
import { WebhookAuthSchema, WebhookFilterSchema, WebhookTargetSchema } from "../webhook/types.js";

// Unified Automations: schedules + webhooks + tunnel-free polled triggers
// (GitHub / Linear, MonoCode-style inbox polling). The existing schedule/*
// and webhook/* RPCs, stores, and behavior are untouched; automation.* is an
// additive facade that delegates per kind.

export const AutomationKindSchema = z.enum(["schedule", "webhook", "github", "linear"]);
export type AutomationKind = z.infer<typeof AutomationKindSchema>;

export const AutomationTargetSchema = WebhookTargetSchema;
export type AutomationTarget = z.infer<typeof AutomationTargetSchema>;

export const AutomationRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "skipped",
  "rejected",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunSummarySchema = z.object({
  id: z.string(),
  trigger: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: AutomationRunStatusSchema,
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable().optional(),
  error: z.string().nullable(),
  eventKey: z.string().optional(),
});
export type AutomationRunSummary = z.infer<typeof AutomationRunSummarySchema>;

export const AutomationScheduleInfoSchema = z.object({
  cadence: ScheduleCadenceSchema,
  status: ScheduleStatusSchema,
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});
export type AutomationScheduleInfo = z.infer<typeof AutomationScheduleInfoSchema>;

export const AutomationWebhookInfoSchema = z.object({
  secret: z.string(),
  auth: WebhookAuthSchema.nullable(),
  filter: WebhookFilterSchema.nullable(),
  lastFiredAt: z.string().nullable(),
});
export type AutomationWebhookInfo = z.infer<typeof AutomationWebhookInfoSchema>;

export const GithubPollEventSchema = z.enum([
  "pull_request_opened",
  "draft_opened",
  "issue_opened",
  "labelled",
]);
export type GithubPollEvent = z.infer<typeof GithubPollEventSchema>;

export const LinearPollEventSchema = z.enum(["issue_created", "assigned"]);
export type LinearPollEvent = z.infer<typeof LinearPollEventSchema>;

export const AutomationPollInfoSchema = z.object({
  provider: z.enum(["github", "linear"]),
  repos: z.array(z.string()),
  events: z.array(z.string()),
  labels: z.array(z.string()),
  actors: z.array(z.string()),
  pollIntervalSec: z.number().int().positive(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Never the secret itself: true when a token is stored for this automation. */
  hasToken: z.boolean(),
});
export type AutomationPollInfo = z.infer<typeof AutomationPollInfoSchema>;

export const StoredAutomationSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: AutomationKindSchema,
  enabled: z.boolean(),
  target: AutomationTargetSchema,
  promptTemplate: z.string().min(1),
  schedule: AutomationScheduleInfoSchema.optional(),
  webhook: AutomationWebhookInfoSchema.optional(),
  poll: AutomationPollInfoSchema.optional(),
  recentRuns: z.array(AutomationRunSummarySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredAutomation = z.infer<typeof StoredAutomationSchema>;

export const AutomationSummarySchema = StoredAutomationSchema;
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
