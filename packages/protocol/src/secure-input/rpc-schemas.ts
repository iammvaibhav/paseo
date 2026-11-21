import { z } from "zod";

/**
 * A secure input request is a daemon-owned permission request (kind "other",
 * name SECURE_INPUT_PERMISSION_NAME) whose `metadata.secureInput` carries the
 * form below. It describes the fields only; values never ride on permission
 * messages. The app submits values with `secure_input.submit.request`, which
 * the daemon answers without echoing them, and cancels through the ordinary
 * `agent_permission_response` deny.
 */
export const SECURE_INPUT_PERMISSION_NAME = "request_secure_input";

export const SECURE_INPUT_FIELD_TYPES = [
  "password",
  "otp",
  "text",
  "email",
  "url",
  "number",
  "textarea",
] as const;

export const SecureInputFieldTypeSchema = z.enum(SECURE_INPUT_FIELD_TYPES);

/** Field names double as file names and env var names, so they stay identifier-shaped. */
export const SECURE_INPUT_FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const SecureInputFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: SecureInputFieldTypeSchema,
  /** True: the agent gets a reference, never the value. False: the value comes back in plain text. */
  secret: z.boolean(),
  required: z.boolean(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
});

export const SecureInputFormSchema = z.object({
  fields: z.array(SecureInputFieldSchema),
  /** ISO time after which the daemon stops waiting and the agent gets status "timeout". */
  expiresAt: z.string(),
});

export type SecureInputFieldType = z.infer<typeof SecureInputFieldTypeSchema>;
export type SecureInputField = z.infer<typeof SecureInputFieldSchema>;
export type SecureInputForm = z.infer<typeof SecureInputFormSchema>;

export const SecureInputSubmitRequestSchema = z.object({
  type: z.literal("secure_input.submit.request"),
  requestId: z.string(),
  agentId: z.string(),
  /** The permission request id of the secure input card. */
  secureInputId: z.string(),
  /** Field name to value. Empty optional fields are omitted. */
  values: z.record(z.string(), z.string()),
});

export const SecureInputSubmitResponseSchema = z.object({
  type: z.literal("secure_input.submit.response"),
  payload: z.object({
    requestId: z.string(),
    secureInputId: z.string(),
    accepted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export type SecureInputSubmitRequest = z.infer<typeof SecureInputSubmitRequestSchema>;
export type SecureInputSubmitResponse = z.infer<typeof SecureInputSubmitResponseSchema>;
