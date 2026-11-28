import { z } from "zod";
import { SecureInputFieldTypeSchema } from "@getpaseo/protocol/secure-input/rpc-schemas";
import { ensureValidJson } from "../json-utils.js";
import type { RegisterToolFn } from "../agent/tools/fleet-control-tools.js";
import type { PaseoToolResult } from "../agent/tools/types.js";
import { SECURE_INPUT_MAX_FIELDS, type SecureInputService } from "./secure-input-service.js";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 4 * 3600;

export interface RegisterSecureInputToolsOptions {
  registerTool: RegisterToolFn;
  /** Absent → this host cannot take secure input and the tools are not offered. */
  secureInput: SecureInputService | null | undefined;
  /** The tools act for one agent: its chat shows the form and only it can use the values. */
  callerAgentId: string | undefined;
}

function result(value: unknown): PaseoToolResult {
  return { content: [], structuredContent: ensureValidJson(value) };
}

const USAGE =
  "Use a secret only inside a command, never print it: " +
  '`curl -u "me:$(cat FILE)" …`, `tool --password-file FILE`, `(. ENV_FILE && cmd)`, or ' +
  "browser_fill with secretRef. Never cat, echo or log the file, and never put the value in chat, " +
  "a ticket, a commit or a memory note. Call release_secure_input with ref when done.";

const RequestSecureInputSchema = z.object({
  title: z.string().trim().min(1).max(120).describe("What the input is for, e.g. 'Grafana login'."),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe("Why you need it and what you will do with it. Shown on the form."),
  fields: z
    .array(
      z.object({
        name: z
          .string()
          .describe("lower_snake_case id; also the file name and (upper-cased) env var name."),
        label: z.string().trim().min(1).max(80),
        type: SecureInputFieldTypeSchema.describe(
          "password/otp are masked; textarea for multi-line values such as keys.",
        ),
        secret: z
          .boolean()
          .optional()
          .describe("Default true. false returns the value in plain text (usernames, hosts)."),
        required: z.boolean().optional().describe("Default true."),
        description: z.string().max(300).optional(),
        placeholder: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(SECURE_INPUT_MAX_FIELDS),
  timeoutSeconds: z
    .number()
    .int()
    .min(30)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`How long to wait for the user. Default ${DEFAULT_TIMEOUT_SECONDS}.`),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(MAX_TTL_SECONDS)
    .optional()
    .describe(`How long secret files and refs live after submit. Default ${DEFAULT_TTL_SECONDS}.`),
  vault: z
    .object({
      field: z.string().describe("The secret field to store."),
      account: z.string().describe("Aside account email."),
      title: z.string().min(1).max(120),
      category: z.enum(["login", "api", "note", "card", "ssh", "bank"]).optional(),
      subtitle: z.string().max(120).optional(),
      url: z.string().max(500).optional(),
      usernameField: z
        .string()
        .optional()
        .describe("A secret:false field whose value becomes the item's username."),
    })
    .optional()
    .describe("Also save one secret field to Aside vault from the daemon."),
});

export function registerSecureInputTools(options: RegisterSecureInputToolsOptions): void {
  const { registerTool, secureInput, callerAgentId } = options;
  if (!secureInput || !callerAgentId) return;

  registerTool(
    "request_secure_input",
    {
      title: "Request secure input",
      description:
        "Ask the user for passwords, OTP codes, API keys, tokens or any other fields through a masked form " +
        "in this chat in the Paseo app (desktop, web, iOS). Use it whenever you need a secret: never ask " +
        "for one in plain chat. Blocks until the user submits, cancels, or timeoutSeconds passes " +
        '(status "submitted", "cancelled" or "timeout"). Fields are secret unless you set secret:false. ' +
        "A secret field comes back as a reference, never the value: `secrets.<name>.file` (0600 file with " +
        "exactly the value), `envFile` (exports NAME=value for every secret field) and " +
        "`secrets.<name>.secretRef` for browser_fill. Files and refs expire at expiresAt (ttlSeconds). " +
        "secret:false fields come back in plain text in `values`. With `vault`, the daemon also saves one " +
        "secret field to Aside vault and returns the item id. " +
        USAGE,
      inputSchema: RequestSecureInputSchema,
    },
    async (input: z.infer<typeof RequestSecureInputSchema>, context) => {
      try {
        const outcome = await secureInput.request(callerAgentId, {
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          fields: input.fields,
          timeoutMs: (input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
          ttlMs: (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
          ...(input.vault ? { vault: input.vault } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return result(outcome.status === "submitted" ? { ...outcome, usage: USAGE } : outcome);
      } catch (error) {
        return {
          ...result({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }),
          isError: true,
        };
      }
    },
  );

  registerTool(
    "release_secure_input",
    {
      title: "Release secure input",
      description:
        "Delete the files and stored values of a request_secure_input submission now, before it expires. " +
        "Call it as soon as you have used the values.",
      inputSchema: { ref: z.string().describe("The ref request_secure_input returned.") },
    },
    async ({ ref }: { ref: string }) =>
      result({ released: await secureInput.release(callerAgentId, ref) }),
  );
}
