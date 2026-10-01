import { z } from "zod";
import {
  AutomationKindSchema,
  AutomationRunSummarySchema,
  StoredAutomationSchema,
} from "./types.js";
import { ScheduleCadenceSchema } from "../schedule/types.js";
import { WebhookAuthSchema, WebhookFilterSchema, WebhookTargetSchema } from "../webhook/types.js";

// Every automation.* request/response pair follows docs/rpc-namespacing.md:
// params at the top level of the request, results under `payload`, and
// `error` null on success.

function request<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...shape }),
  });
}

const AutomationTargetInputSchema = WebhookTargetSchema;

export const AutomationListRequestSchema = request("automation.list.request", {});
export const AutomationListResponseSchema = response("automation.list.response", {
  automations: z.array(StoredAutomationSchema),
});

export const AutomationCreateRequestSchema = request("automation.create.request", {
  name: z.string().nullable().optional(),
  kind: AutomationKindSchema,
  target: AutomationTargetInputSchema,
  promptTemplate: z.string().min(1),
  schedule: z.object({ cadence: ScheduleCadenceSchema }).optional(),
  webhook: z
    .object({
      auth: WebhookAuthSchema.nullable().optional(),
      filter: WebhookFilterSchema.nullable().optional(),
    })
    .optional(),
  poll: z
    .object({
      repos: z.array(z.string()).optional(),
      events: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      actors: z.array(z.string()).optional(),
      pollIntervalSec: z.number().int().positive().optional(),
      /** Optional secret: GitHub token override, or Linear API key. */
      token: z.string().min(1).optional(),
    })
    .optional(),
});
export const AutomationCreateResponseSchema = response("automation.create.response", {
  automation: StoredAutomationSchema.nullable(),
});

export const AutomationInspectRequestSchema = request("automation.inspect.request", {
  automationId: z.string(),
});
export const AutomationInspectResponseSchema = response("automation.inspect.response", {
  automation: StoredAutomationSchema.nullable(),
});

export const AutomationUpdateRequestSchema = request("automation.update.request", {
  automationId: z.string(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  target: AutomationTargetInputSchema.optional(),
  promptTemplate: z.string().min(1).optional(),
  schedule: z.object({ cadence: ScheduleCadenceSchema }).optional(),
  webhook: z
    .object({
      auth: WebhookAuthSchema.nullable().optional(),
      filter: WebhookFilterSchema.nullable().optional(),
    })
    .optional(),
  poll: z
    .object({
      repos: z.array(z.string()).optional(),
      events: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      actors: z.array(z.string()).optional(),
      pollIntervalSec: z.number().int().positive().optional(),
      /** String sets the secret; explicit null clears it. */
      token: z.string().min(1).nullable().optional(),
    })
    .optional(),
});
export const AutomationUpdateResponseSchema = response("automation.update.response", {
  automation: StoredAutomationSchema.nullable(),
});

export const AutomationDeleteRequestSchema = request("automation.delete.request", {
  automationId: z.string(),
});
export const AutomationDeleteResponseSchema = response("automation.delete.response", {
  automationId: z.string(),
});

/** Run-now: schedule → runOnce; webhook → test; poll → immediate tick. */
export const AutomationRunRequestSchema = request("automation.run.request", {
  automationId: z.string(),
  samplePayload: z.string().optional(),
});
export const AutomationRunResponseSchema = response("automation.run.response", {
  run: AutomationRunSummarySchema.nullable(),
});

/** Poll-source health without secrets. */
export const AutomationStatusRequestSchema = request("automation.status.request", {});
export const AutomationStatusResponseSchema = response("automation.status.response", {
  github: z.object({ cliPresent: z.boolean(), authenticated: z.boolean() }),
  linear: z.object({ configured: z.boolean() }),
  claimsDurable: z.boolean(),
});

/**
 * Owned-subscription push (subscribe only on hosts advertising
 * features.automations + automationEventSubscription). `revision` is a
 * per-daemon monotonic counter.
 */
export const AutomationsChangedMessageSchema = z.object({
  type: z.literal("automations.changed"),
  subscriptionId: z.string().optional(),
  automationId: z.string(),
  kind: z.string(),
  revision: z.number(),
});
export type AutomationsChangedMessage = z.infer<typeof AutomationsChangedMessageSchema>;

export const AUTOMATION_INBOUND_SCHEMAS = [
  AutomationListRequestSchema,
  AutomationCreateRequestSchema,
  AutomationInspectRequestSchema,
  AutomationUpdateRequestSchema,
  AutomationDeleteRequestSchema,
  AutomationRunRequestSchema,
  AutomationStatusRequestSchema,
] as const;

export const AUTOMATION_OUTBOUND_SCHEMAS = [
  AutomationListResponseSchema,
  AutomationCreateResponseSchema,
  AutomationInspectResponseSchema,
  AutomationUpdateResponseSchema,
  AutomationDeleteResponseSchema,
  AutomationRunResponseSchema,
  AutomationStatusResponseSchema,
  AutomationsChangedMessageSchema,
] as const;
