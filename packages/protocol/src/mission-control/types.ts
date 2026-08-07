import { z } from "zod";

// Mission Control fleet events: deterministic transition cards from the daemon
// detectors plus summarizer judgment cards. One shared shape for the feed, the
// event store, and the wire.
export const MissionControlEventKindSchema = z.enum([
  "started",
  "finished",
  "failed",
  "blocked",
  "stalled",
  "milestone",
  "finding",
  "diverged",
]);
export type MissionControlEventKind = z.infer<typeof MissionControlEventKindSchema>;

export const MissionControlProofSchema = z.object({
  kind: z.enum(["url", "image", "diff", "command"]),
  url: z.string().optional(),
  path: z.string().optional(),
  label: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  exitCode: z.number().optional(),
});
export type MissionControlProof = z.infer<typeof MissionControlProofSchema>;

export const MissionControlEventSchema = z.object({
  id: z.string(), // "mce_" + ulid
  ts: z.string(), // ISO
  agentId: z.string(),
  agentTitle: z.string(),
  kind: MissionControlEventKindSchema,
  source: z.enum(["system", "summarizer"]),
  severity: z.enum(["info", "attention", "blocker"]),
  headline: z.string(), // ≤ 120 chars, plain language
  detail: z.string().optional(),
  proof: z.array(MissionControlProofSchema).optional(),
  supersedesId: z.string().optional(), // coalescing chain
  coalescedCount: z.number().optional(),
});
export type MissionControlEvent = z.infer<typeof MissionControlEventSchema>;

export const MissionControlPeerStatusSchema = z.object({
  name: z.string(), // config name, e.g. "macbook"
  url: z.string(),
  state: z.enum(["online", "unreachable"]),
  lastSeenAt: z.string().nullable(), // for "unreachable since 12:03, likely asleep"
});
export type MissionControlPeerStatus = z.infer<typeof MissionControlPeerStatusSchema>;

export const MissionControlEventsFetchRequestSchema = z.object({
  type: z.literal("mission_control.events.fetch.request"),
  requestId: z.string(),
  sinceTs: z.string().optional(),
  limit: z.number().int().optional(),
});
export type MissionControlEventsFetchRequest = z.infer<
  typeof MissionControlEventsFetchRequestSchema
>;

export const MissionControlEventsFetchResponseSchema = z.object({
  type: z.literal("mission_control.events.fetch.response"),
  payload: z.object({
    requestId: z.string(),
    events: z.array(MissionControlEventSchema),
  }),
});
export type MissionControlEventsFetchResponse = z.infer<
  typeof MissionControlEventsFetchResponseSchema
>;

export const MissionControlEventsAckRequestSchema = z.object({
  type: z.literal("mission_control.events.ack.request"),
  requestId: z.string(),
  eventIds: z.array(z.string()),
});
export type MissionControlEventsAckRequest = z.infer<typeof MissionControlEventsAckRequestSchema>;

export const MissionControlEventsAckResponseSchema = z.object({
  type: z.literal("mission_control.events.ack.response"),
  payload: z.object({
    requestId: z.string(),
  }),
});
export type MissionControlEventsAckResponse = z.infer<typeof MissionControlEventsAckResponseSchema>;

export const MissionControlPeersListRequestSchema = z.object({
  type: z.literal("mission_control.peers.list.request"),
  requestId: z.string(),
});
export type MissionControlPeersListRequest = z.infer<typeof MissionControlPeersListRequestSchema>;

export const MissionControlPeersListResponseSchema = z.object({
  type: z.literal("mission_control.peers.list.response"),
  payload: z.object({
    requestId: z.string(),
    peers: z.array(MissionControlPeerStatusSchema),
  }),
});
export type MissionControlPeersListResponse = z.infer<typeof MissionControlPeersListResponseSchema>;

// Server → client push on every new mission control event. Not a request/response pair.
export const MissionControlEventMessageSchema = z.object({
  type: z.literal("mission_control_event"),
  event: MissionControlEventSchema,
});
export type MissionControlEventMessage = z.infer<typeof MissionControlEventMessageSchema>;
