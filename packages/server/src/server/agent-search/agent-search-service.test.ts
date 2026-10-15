import { describe, expect, test } from "vitest";
import { AgentSearchService } from "./agent-search-service.js";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent/agent-storage.js";
import type { MissionControlRunRecord } from "../mission-control/run-records.js";
import type { TranscriptHit } from "../search/service.js";

function agent(id: string, fields: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return parseStoredAgentRecord({
    id,
    provider: "omp",
    cwd: `/work/${id}`,
    workspaceId: `wks_${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    title: `Agent ${id}`,
    ...fields,
  });
}

function run(agentId: string, brief: string, endedAt: string, headline?: string) {
  return {
    agentId,
    brief,
    endedAt,
    reports: headline ? [{ ts: endedAt, kind: "finished", headline }] : [],
  } as unknown as MissionControlRunRecord;
}

function service(input: {
  agents: StoredAgentRecord[];
  runs?: MissionControlRunRecord[];
  transcripts?: (query: string) => TranscriptHit[];
}) {
  return new AgentSearchService({
    listAgents: async () => input.agents,
    getRunRecords: () => input.runs ?? [],
    readLiveBrief: async () => null,
    searchTranscripts: input.transcripts ?? (() => []),
  });
}

const ids = (result: { matches: { agentId: string }[] }) =>
  result.matches.map((match) => match.agentId);

describe("AgentSearchService", () => {
  test("finds an agent by its name, title, or id prefix, including closed agents", async () => {
    const agents = [
      agent("1e1d8ead-2444-4a39-89a9-a4cca2d2411c", {
        name: "Lively Fable",
        title: "Research X trending",
        lastStatus: "closed",
      }),
      agent("bc4c87f8-be87-4c06-b91f-d90480e2e555", { name: "Merry Otter", title: "Deploy fix" }),
    ];

    expect(ids(await service({ agents }).search({ query: "lively fable" }))).toEqual([
      "1e1d8ead-2444-4a39-89a9-a4cca2d2411c",
    ]);
    expect(ids(await service({ agents }).search({ query: "X trending" }))).toEqual([
      "1e1d8ead-2444-4a39-89a9-a4cca2d2411c",
    ]);
    expect(ids(await service({ agents }).search({ query: "bc4c87f8" }))).toEqual([
      "bc4c87f8-be87-4c06-b91f-d90480e2e555",
    ]);
  });

  test("matches every query word across description, launch prompt, and last report", async () => {
    const result = await service({
      agents: [
        agent("a", { title: "Fix deploy", shortDescription: "Rewrote the inventory" }),
        agent("b", { title: "Chat links" }),
      ],
      // Newest first, as MissionControlService.getRunRecords returns them.
      runs: [
        run("b", "follow-up: ship it", "2026-10-03T00:00:00.000Z", "Anchors open in browser"),
        run("b", "make markdown links clickable", "2026-10-02T00:00:00.000Z"),
      ],
    }).search({ query: "deploy inventory" });
    expect(ids(result)).toEqual(["a"]);
    expect(result.matches[0]).toMatchObject({ lexical: true, score: null });
    expect(result.semantic).toBe(false);

    const byBrief = await service({
      agents: [agent("b", { title: "Chat links" })],
      runs: [
        run("b", "follow-up: ship it", "2026-10-03T00:00:00.000Z", "Anchors open in browser"),
        run("b", "make markdown links clickable", "2026-10-02T00:00:00.000Z"),
      ],
    });
    expect(ids(await byBrief.search({ query: "markdown clickable" }))).toEqual(["b"]);
    expect(ids(await byBrief.search({ query: "anchors browser" }))).toEqual(["b"]);
  });

  test("transcript hits widen the result and rank after metadata matches, best bm25 first", async () => {
    const result = await service({
      agents: [agent("meta", { title: "Kinesis alarm" }), agent("deep"), agent("deeper")],
      transcripts: () => [
        { agentId: "deeper", rank: -9, snippet: "kinesis fan-out" },
        { agentId: "meta", rank: -8, snippet: "kinesis" },
        { agentId: "deep", rank: -2, snippet: "kinesis" },
        { agentId: "unknown", rank: -10, snippet: "kinesis" },
      ],
    }).search({ query: "kinesis" });

    expect(ids(result)).toEqual(["meta", "deeper", "deep"]);
    expect(result.matches.map((match) => match.lexical)).toEqual([true, false, false]);
  });

  test("name and title matches rank ahead of description-only matches", async () => {
    const result = await service({
      agents: [
        agent("desc", { title: "Other", shortDescription: "touched the fable renderer" }),
        agent("name", { name: "Lively Fable", lastActivityAt: "2026-09-01T00:00:00.000Z" }),
      ],
    }).search({ query: "fable" });
    expect(ids(result)).toEqual(["name", "desc"]);
  });

  test("archived agents only with includeArchived; internal and machinery never", async () => {
    const agents = [
      agent("live", { title: "deploy live" }),
      agent("old", { title: "deploy old", archivedAt: "2026-10-05T00:00:00.000Z" }),
      agent("hidden", { title: "deploy hidden", internal: true }),
      agent("commander", {
        title: "deploy commander",
        labels: { "paseo.mission-control": "commander" },
      }),
    ];
    const transcripts = () => [{ agentId: "hidden", rank: -5, snippet: "deploy" }];

    const active = await service({ agents, transcripts }).search({ query: "deploy" });
    expect(ids(active)).toEqual(["live"]);

    const all = await service({ agents, transcripts }).search({
      query: "deploy",
      includeArchived: true,
    });
    expect(ids(all).sort()).toEqual(["live", "old"]);
    expect(all.matches.find((match) => match.agentId === "old")?.archivedAt).toBe(
      "2026-10-05T00:00:00.000Z",
    );
  });

  test("a blank query matches nothing and skips the transcript index", async () => {
    let transcriptQueries = 0;
    const result = await service({
      agents: [agent("a")],
      transcripts: () => {
        transcriptQueries += 1;
        return [{ agentId: "a", rank: -1, snippet: "" }];
      },
    }).search({ query: "   " });
    expect(result.matches).toEqual([]);
    expect(transcriptQueries).toBe(0);
  });
});
