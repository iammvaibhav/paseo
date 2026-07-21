import { z } from "zod";

/** Decision shapes emitted by `plannotator annotate --json` on process exit. */
export const PlannotatorDecisionSchema = z.enum(["approved", "annotated", "dismissed", "block"]);

export const PlannotatorSessionKindSchema = z.enum(["annotate"]);

export const PlannotatorSessionStartRequestSchema = z.object({
  type: z.literal("plannotator.session.start.request"),
  requestId: z.string(),
  kind: PlannotatorSessionKindSchema,
  /** Absolute path to the file to annotate (host filesystem). */
  path: z.string().min(1),
  /** Workspace root used as cwd and for path allowlisting. */
  workspaceDir: z.string().min(1),
  /** Optional agent to route feedback to. */
  agentId: z.string().optional(),
  /** Client-side workspace tab key (for closing the right tab). */
  workspaceKey: z.string().optional(),
  /**
   * When true, spawn with PLANNOTATOR_REMOTE=1 so the session binds 0.0.0.0
   * (needed for desktop embedding of remote-host sessions over VPN).
   */
  remote: z.boolean().optional(),
});

export const PlannotatorSessionStartResponseSchema = z.object({
  type: z.literal("plannotator.session.start.response"),
  payload: z.object({
    requestId: z.string(),
    sessionId: z.string().nullable(),
    port: z.number().int().positive().nullable(),
    url: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const PlannotatorSessionStopRequestSchema = z.object({
  type: z.literal("plannotator.session.stop.request"),
  requestId: z.string(),
  sessionId: z.string().min(1),
});

export const PlannotatorSessionStopResponseSchema = z.object({
  type: z.literal("plannotator.session.stop.response"),
  payload: z.object({
    requestId: z.string(),
    sessionId: z.string(),
    error: z.string().nullable(),
  }),
});

/**
 * Server → client push when a session ends (submit, approve, dismiss, or kill).
 * Not a request/response pair.
 */
export const PlannotatorSessionEventSchema = z.object({
  type: z.literal("plannotator.session.event"),
  payload: z.object({
    sessionId: z.string(),
    kind: PlannotatorSessionKindSchema,
    path: z.string().optional(),
    agentId: z.string().optional(),
    workspaceKey: z.string().optional(),
    /**
     * `feedback` = process exited with a decision (approved/annotated/…).
     * `closed` = process ended without structured feedback (user closed / kill).
     */
    event: z.enum(["feedback", "closed"]),
    decision: PlannotatorDecisionSchema.optional(),
    /** Human-readable feedback body (annotations / deny message). */
    feedback: z.string().optional(),
    /** Raw stdout JSON when available (for debugging / future fields). */
    raw: z.unknown().optional(),
  }),
});

export type PlannotatorSessionStartRequest = z.infer<typeof PlannotatorSessionStartRequestSchema>;
export type PlannotatorSessionStartResponse = z.infer<typeof PlannotatorSessionStartResponseSchema>;
export type PlannotatorSessionStopRequest = z.infer<typeof PlannotatorSessionStopRequestSchema>;
export type PlannotatorSessionStopResponse = z.infer<typeof PlannotatorSessionStopResponseSchema>;
export type PlannotatorSessionEvent = z.infer<typeof PlannotatorSessionEventSchema>;
