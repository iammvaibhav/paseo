import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import {
  MissionControlContextRecordsRequestSchema,
  MissionControlContextRecordsResponseSchema,
  MissionControlPeerTimelineRequestSchema,
  MissionControlPeerTimelineResponseSchema,
  MissionControlRecallRequestSchema,
  MissionControlRecallResponseSchema,
  MissionControlTagMessageRequestSchema,
  MissionControlTagMessageResponseSchema,
} from "./types.js";

// M11 voice read RPCs: thin session RPCs the voice node uses for
// fleet_recall / fleet_context / tag_message / peer fleet_get_agent_activity.
// These tests pin the wire shapes and their membership in the session
// inbound/outbound unions (the daemon's zod-aot validator derives from the
// same schemas).

describe("mission_control.recall request/response", () => {
  test("request parses with only query (limit optional)", () => {
    const parsed = MissionControlRecallRequestSchema.parse({
      type: "mission_control.recall.request",
      requestId: "req-recall-1",
      query: "who fixed the auth bug",
    });
    expect(parsed.limit).toBeUndefined();
  });

  test("request accepts a bounded limit", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "mission_control.recall.request",
      requestId: "req-recall-2",
      query: "clipping bug",
      limit: 3,
    });
    expect(parsed.type).toBe("mission_control.recall.request");
  });

  test("request rejects an empty query at the schema boundary", () => {
    expect(
      MissionControlRecallRequestSchema.safeParse({
        type: "mission_control.recall.request",
        requestId: "req-recall-3",
        query: "",
      }).success,
    ).toBe(false);
  });

  test("response carries ok:false + reason when the bank is unavailable", () => {
    const parsed = MissionControlRecallResponseSchema.parse({
      type: "mission_control.recall.response",
      payload: { requestId: "req-recall-1", ok: false, reason: "memory unavailable" },
    });
    expect(parsed.payload.matches).toBeUndefined();
  });

  test("response carries matches with attribution when ok", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "mission_control.recall.response",
      payload: {
        requestId: "req-recall-1",
        ok: true,
        matches: [
          {
            id: "mem_1",
            text: "Pia fixed the auth bug in #42",
            context: null,
            occurredStart: "2026-08-01T00:00:00.000Z",
            documentId: "paseo-run:mcr_pia_1",
            tags: ["project:acme"],
            bank: "paseo-fleet",
            sessionId: null,
            entities: null,
            metadata: null,
          },
          {
            id: "mem_2",
            text: "transcript about the clipping bug",
            context: null,
            occurredStart: null,
            documentId: null,
            tags: null,
            bank: "omp",
            sessionId: "sess-omp-1",
            entities: ["agent-a"],
            metadata: { session_id: "sess-omp-1" },
            attribution: {
              agentId: "agent-a",
              agentName: "archimedes",
              agentTitle: "Archimedes",
              workspaceId: "wks_1",
            },
          },
        ],
      },
    });
    expect(parsed.type).toBe("mission_control.recall.response");
  });
});

describe("mission_control.context.records request/response", () => {
  test("request parses with optional selectors", () => {
    const parsed = MissionControlContextRecordsRequestSchema.parse({
      type: "mission_control.context.records.request",
      requestId: "req-ctx-1",
      agentId: "agent-a",
    });
    expect(parsed.workspaceId).toBeUndefined();
    expect(parsed.projectId).toBeUndefined();
  });

  test("bare request (no selectors) is valid — most recent records fleet-wide", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "mission_control.context.records.request",
        requestId: "req-ctx-2",
      }).success,
    ).toBe(true);
  });

  test("response carries run records plus an optional workspace rollup", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "mission_control.context.records.response",
      payload: {
        requestId: "req-ctx-1",
        ok: true,
        runRecords: [
          {
            id: "mcr_agent-a_1",
            agentId: "agent-a",
            agentName: "archimedes",
            agentTitle: "Archimedes",
            hostAlias: "local",
            serverId: "srv-1",
            workspaceId: "wks_1",
            workspaceTitle: "Payments work",
            projectId: "prj_1",
            projectName: "Acme",
            runEpoch: 1,
            startedAt: "2026-08-01T00:00:00.000Z",
            endedAt: "2026-08-01T01:00:00.000Z",
            outcome: "finished",
            brief: "Fix the auth bug",
            reports: [
              {
                ts: "2026-08-01T00:30:00.000Z",
                kind: "milestone",
                headline: "Reproduced the 401",
              },
            ],
            verdict: {
              by: "verifier",
              summary: "Fix verified",
              at: "2026-08-01T02:00:00.000Z",
              verifierAgentId: "mcv_1",
            },
            proofs: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T02:00:00.000Z",
          },
        ],
        workspaceRollup: {
          kind: "workspace",
          workspaceId: "wks_1",
          workspaceTitle: "Payments work",
          projectId: "prj_1",
          projectName: "Acme",
          updatedAt: "2026-08-01T02:00:00.000Z",
          runs: [
            {
              agentId: "agent-a",
              agentName: "archimedes",
              endedAt: "2026-08-01T01:00:00.000Z",
              outcome: "finished",
              brief: "Fix the auth bug",
              decisions: [],
              open: [],
              verdict: "Fix verified",
            },
          ],
        },
      },
    });
    expect(parsed.type).toBe("mission_control.context.records.response");
  });

  test("response degrades with ok:false + error", () => {
    const parsed = MissionControlContextRecordsResponseSchema.parse({
      type: "mission_control.context.records.response",
      payload: {
        requestId: "req-ctx-2",
        ok: false,
        runRecords: [],
        error: "Mission Control is not enabled on this host",
      },
    });
    expect(parsed.payload.error).toMatch(/not enabled/);
  });
});

describe("mission_control.tag_message request/response", () => {
  test("request requires at least one agent id", () => {
    expect(
      MissionControlTagMessageRequestSchema.safeParse({
        type: "mission_control.tag_message.request",
        requestId: "req-tag-1",
        agentIds: [],
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "mission_control.tag_message.request",
        requestId: "req-tag-2",
        agentIds: ["agent-a", "agent-b"],
      }).success,
    ).toBe(true);
  });

  test("request accepts an optional messageText override", () => {
    const parsed = MissionControlTagMessageRequestSchema.parse({
      type: "mission_control.tag_message.request",
      requestId: "req-tag-3",
      agentIds: ["agent-a"],
      messageText: "check on Archimedes",
    });
    expect(parsed.messageText).toBe("check on Archimedes");
  });

  test("response carries ok + optional error", () => {
    const ok = SessionOutboundMessageSchema.parse({
      type: "mission_control.tag_message.response",
      payload: { requestId: "req-tag-1", ok: true },
    });
    expect(ok.type).toBe("mission_control.tag_message.response");
    const failed = MissionControlTagMessageResponseSchema.parse({
      type: "mission_control.tag_message.response",
      payload: { requestId: "req-tag-2", ok: false, error: "No user message to tag" },
    });
    expect(failed.payload.error).toBe("No user message to tag");
  });
});

describe("mission_control.peer.timeline request/response", () => {
  test("request requires host + agentId; limit optional", () => {
    expect(
      MissionControlPeerTimelineRequestSchema.safeParse({
        type: "mission_control.peer.timeline.request",
        requestId: "req-peer-1",
        host: "",
        agentId: "agent-a",
      }).success,
    ).toBe(false);
    const parsed = SessionInboundMessageSchema.parse({
      type: "mission_control.peer.timeline.request",
      requestId: "req-peer-2",
      host: "macbook",
      agentId: "agent-a",
      limit: 10,
    });
    expect(parsed.type).toBe("mission_control.peer.timeline.request");
  });

  test("response carries the curated content + updateCount when ok", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "mission_control.peer.timeline.response",
      payload: {
        requestId: "req-peer-2",
        ok: true,
        content: "Showing all 2 activities\n\n[User] do the thing | done.",
        updateCount: 2,
      },
    });
    expect(parsed.type).toBe("mission_control.peer.timeline.response");
  });

  test("response surfaces a peer error", () => {
    const parsed = MissionControlPeerTimelineResponseSchema.parse({
      type: "mission_control.peer.timeline.response",
      payload: {
        requestId: "req-peer-3",
        ok: false,
        error: 'Host "macbook" is not a configured peer',
      },
    });
    expect(parsed.payload.error).toMatch(/not a configured peer/);
  });
});
