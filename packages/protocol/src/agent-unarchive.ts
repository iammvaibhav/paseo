import { z } from "zod";

/**
 * Bring an archived agent back so it opens like any other agent: its
 * workspace is restored first when that is archived too (its project with
 * it), then the agent is unarchived. A failed restore leaves the agent
 * archived. The same daemon logic serves the fleet_unarchive_agent tool.
 */

export const AgentUnarchiveRequestSchema = z.object({
  type: z.literal("agent.unarchive.request"),
  requestId: z.string(),
  agentId: z.string(),
});
export type AgentUnarchiveRequest = z.infer<typeof AgentUnarchiveRequestSchema>;

export const AgentUnarchiveResponseSchema = z.object({
  type: z.literal("agent.unarchive.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    // The archived workspace restored along with the agent; null when it was active.
    restoredWorkspaceId: z.string().nullable(),
    // The agent's workspace after the restore.
    workspaceId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
export type AgentUnarchiveResponse = z.infer<typeof AgentUnarchiveResponseSchema>;
