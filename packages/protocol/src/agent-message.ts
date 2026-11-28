import { z } from "zod";

/** Semantic provenance, independent of provider envelopes and timeline presentation. */
export const AgentMessageSchema = z.object({
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
  sender: z.object({
    /** An agent id, or for a "client" sender its name. */
    id: z.string().min(1),
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    /** Absent means an agent. A client is a named caller such as grok-bot or an n8n flow. */
    kind: z.enum(["agent", "client"]).optional(),
  }),
  text: z.string(),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
