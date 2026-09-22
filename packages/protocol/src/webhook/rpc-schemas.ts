import { z } from "zod";
import {
  StoredWebhookSchema,
  WebhookAuthSchema,
  WebhookDeliverySchema,
  WebhookFilterSchema,
  WebhookSummarySchema,
  WebhookTargetSchema,
  WebhookTunnelProviderSchema,
  WebhookTunnelStatusSchema,
} from "./types.js";

export const WebhookCreateRequestSchema = z.object({
  type: z.literal("webhook/create"),
  requestId: z.string(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  target: WebhookTargetSchema,
  promptTemplate: z.string().min(1),
  auth: WebhookAuthSchema.nullable().optional(),
  filter: WebhookFilterSchema.nullable().optional(),
});

export const WebhookListRequestSchema = z.object({
  type: z.literal("webhook/list"),
  requestId: z.string(),
});

export const WebhookInspectRequestSchema = z.object({
  type: z.literal("webhook/inspect"),
  requestId: z.string(),
  webhookId: z.string(),
});

export const WebhookDeleteRequestSchema = z.object({
  type: z.literal("webhook/delete"),
  requestId: z.string(),
  webhookId: z.string(),
});

export const WebhookUpdateRequestSchema = z.object({
  type: z.literal("webhook/update"),
  requestId: z.string(),
  webhookId: z.string(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  target: WebhookTargetSchema.optional(),
  promptTemplate: z.string().min(1).optional(),
  auth: WebhookAuthSchema.nullable().optional(),
  filter: WebhookFilterSchema.nullable().optional(),
});

// Fire the hook immediately with a caller-supplied sample body, for testing.
export const WebhookTestRequestSchema = z.object({
  type: z.literal("webhook/test"),
  requestId: z.string(),
  webhookId: z.string(),
  samplePayload: z.string().optional(),
});

export const WebhookConfigRequestSchema = z.object({
  type: z.literal("webhook/config"),
  requestId: z.string(),
});

export const WebhookCreateResponseSchema = z.object({
  type: z.literal("webhook/create/response"),
  payload: z.object({
    requestId: z.string(),
    webhook: WebhookSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const WebhookListResponseSchema = z.object({
  type: z.literal("webhook/list/response"),
  payload: z.object({
    requestId: z.string(),
    webhooks: z.array(WebhookSummarySchema),
    // Public base URL from the daemon's tunnel, for building hook links.
    publicBaseUrl: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const WebhookInspectResponseSchema = z.object({
  type: z.literal("webhook/inspect/response"),
  payload: z.object({
    requestId: z.string(),
    webhook: StoredWebhookSchema.nullable(),
    publicBaseUrl: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const WebhookDeleteResponseSchema = z.object({
  type: z.literal("webhook/delete/response"),
  payload: z.object({
    requestId: z.string(),
    webhookId: z.string(),
    error: z.string().nullable(),
  }),
});

export const WebhookUpdateResponseSchema = z.object({
  type: z.literal("webhook/update/response"),
  payload: z.object({
    requestId: z.string(),
    webhook: StoredWebhookSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const WebhookTestResponseSchema = z.object({
  type: z.literal("webhook/test/response"),
  payload: z.object({
    requestId: z.string(),
    delivery: WebhookDeliverySchema.nullable(),
    renderedPrompt: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const WebhookConfigResponseSchema = z.object({
  type: z.literal("webhook/config/response"),
  payload: z.object({
    requestId: z.string(),
    provider: WebhookTunnelProviderSchema,
    status: WebhookTunnelStatusSchema,
    publicBaseUrl: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
