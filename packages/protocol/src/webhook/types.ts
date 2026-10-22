import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";

// A webhook fires an agent when its HTTP path is hit. The target mirrors the
// schedule target: either an existing agent or a freshly-provisioned one. Kept
// as an independent declaration (not imported from schedule) so the two sibling
// features can evolve without coupling their wire schemas.
export const WebhookNewAgentConfigSchema = z.object({
  provider: AgentProviderSchema,
  cwd: z.string().trim().min(1),
  modeId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  thinkingOptionId: z.string().trim().min(1).optional(),
  archiveOnFinish: z.boolean().optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  title: z.string().trim().min(1).nullable().optional(),
  approvalPolicy: z.string().trim().min(1).optional(),
  sandboxMode: z.string().trim().min(1).optional(),
  networkAccess: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  extra: z
    .object({
      codex: z.record(z.string(), z.unknown()).optional(),
      claude: z.record(z.string(), z.unknown()).optional(),
    })
    .partial()
    .optional(),
  systemPrompt: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookNewAgentConfig = z.infer<typeof WebhookNewAgentConfigSchema>;

export const WebhookTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    agentId: z.guid(),
  }),
  z.object({
    type: z.literal("new-agent"),
    config: WebhookNewAgentConfigSchema,
  }),
]);
export type WebhookTarget = z.infer<typeof WebhookTargetSchema>;

// HMAC signature verification. `preset` selects sender-specific header/prefix
// defaults; `custom` requires an explicit header. The daemon recomputes the
// signature over the raw request body and compares it constant-time.
export const WebhookHmacPresetSchema = z.enum(["github", "linear", "custom"]);
export type WebhookHmacPreset = z.infer<typeof WebhookHmacPresetSchema>;

export const WebhookHmacConfigSchema = z.object({
  preset: WebhookHmacPresetSchema,
  secret: z.string().min(1),
  // Overrides for `custom`; ignored (derived) for github/linear presets.
  header: z.string().trim().min(1).optional(),
  algo: z.enum(["sha256", "sha1"]).optional(),
  prefix: z.string().optional(),
});
export type WebhookHmacConfig = z.infer<typeof WebhookHmacConfigSchema>;

export const WebhookAuthSchema = z.object({
  hmac: WebhookHmacConfigSchema.nullable().optional(),
});
export type WebhookAuth = z.infer<typeof WebhookAuthSchema>;

// Optional AND-combined equality rules on the parsed payload, so one hook can
// serve many event types without firing on every one.
export const WebhookFilterRuleSchema = z.object({
  path: z.string().trim().min(1),
  equals: z.string(),
});
export type WebhookFilterRule = z.infer<typeof WebhookFilterRuleSchema>;

export const WebhookFilterSchema = z.object({
  rules: z.array(WebhookFilterRuleSchema),
});
export type WebhookFilter = z.infer<typeof WebhookFilterSchema>;

export const WebhookDeliveryStatusSchema = z.enum(["fired", "skipped", "rejected", "failed"]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  sourceIp: z.string().nullable(),
  // Provider-supplied idempotency key (X-GitHub-Delivery, Linear event id).
  deliveryId: z.string().nullable(),
  status: WebhookDeliveryStatusSchema,
  matched: z.boolean(),
  agentId: z.guid().nullable(),
  workspaceId: z.string().nullable(),
  error: z.string().nullable(),
  payloadSnippet: z.string().nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const StoredWebhookSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  enabled: z.boolean(),
  // High-entropy URL token; part of the hook path /hooks/<id>/<secret>.
  secret: z.string().min(1),
  auth: WebhookAuthSchema.nullable(),
  target: WebhookTargetSchema,
  promptTemplate: z.string().min(1),
  filter: WebhookFilterSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastFiredAt: z.string().nullable(),
  deliveries: z.array(WebhookDeliverySchema),
});
export type StoredWebhook = z.infer<typeof StoredWebhookSchema>;

export const WebhookSummarySchema = StoredWebhookSchema.omit({
  deliveries: true,
});
export type WebhookSummary = z.infer<typeof WebhookSummarySchema>;

// Tunnel status surfaced to the UI so it can render the full public hook URL.
export const WebhookTunnelProviderSchema = z.enum(["tailscale-funnel", "cloudflared", "none"]);
export type WebhookTunnelProvider = z.infer<typeof WebhookTunnelProviderSchema>;

export const WebhookTunnelStatusSchema = z.enum(["running", "stopped", "error", "disabled"]);
export type WebhookTunnelStatus = z.infer<typeof WebhookTunnelStatusSchema>;

export interface CreateWebhookInput {
  name?: string | null;
  enabled?: boolean;
  target: WebhookTarget;
  promptTemplate: string;
  auth?: WebhookAuth | null;
  filter?: WebhookFilter | null;
}

export interface UpdateWebhookInput {
  id: string;
  name?: string | null;
  enabled?: boolean;
  target?: WebhookTarget;
  promptTemplate?: string;
  auth?: WebhookAuth | null;
  filter?: WebhookFilter | null;
}
