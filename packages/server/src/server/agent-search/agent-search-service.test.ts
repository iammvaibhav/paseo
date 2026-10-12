import { describe, expect, test } from "vitest";
import pino from "pino";
import { AgentSearchService } from "./agent-search-service.js";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent/agent-storage.js";
import type { MissionControlRunRecord } from "../mission-control/run-records.js";

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

/** A jev stand-in answering "yes" with the probability `score(card)`. */
function jev(score: (card: string) => number, calls: string[][] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      questions: Record<string, { instructions: string }>;
    };
    calls.push(Object.keys(body.questions));
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const yes = score(question.instructions);
      answers[id] = {
        choice: yes >= 0.5 ? "yes" : "no",
        probabilities: { yes, no: 1 - yes },
      };
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as typeof fetch;
}

function service(input: {
  agents: StoredAgentRecord[];
  runs?: MissionControlRunRecord[];
  key?: string;
  fetchImpl?: typeof fetch;
}) {
  return new AgentSearchService({
    logger: pino({ level: "silent" }),
    listAgents: async () => input.agents,
    getRunRecords: () => input.runs ?? [],
    readLiveBrief: async () => null,
    getTypesafeApiKeyRef: () => input.key,
    resolveSecret: async (value) => value,
    fetchImpl: input.fetchImpl,
  });
}

describe("AgentSearchService", () => {
  test("without a TypeSafe key, matches every query word across title and launch prompt", async () => {
    const result = await service({
      agents: [agent("a", { title: "Fix deploy" }), agent("b", { title: "Chat links" })],
      runs: [run("a", "make the inventory build once", "2026-10-02T00:00:00.000Z")],
    }).search({ query: "deploy inventory" });

    expect(result.semantic).toBe(false);
    expect(result.matches.map((match) => match.agentId)).toEqual(["a"]);
    expect(result.matches[0]).toMatchObject({ lexical: true, score: null });
  });

  test("jev finds agents with no shared words, drops low scores, and ranks by probability", async () => {
    const result = await service({
      agents: [agent("a"), agent("b"), agent("c")],
      runs: [
        run("a", "links in chat are not clickable", "2026-10-02T00:00:00.000Z"),
        run("b", "make markdown anchors open in the browser", "2026-10-02T00:00:00.000Z"),
        run("c", "rotate the api key", "2026-10-02T00:00:00.000Z"),
      ],
      key: "key",
      fetchImpl: jev((card) => {
        if (card.includes("anchors")) return 0.95;
        if (card.includes("clickable")) return 0.7;
        return 0.1;
      }),
    }).search({ query: "broken hyperlinks" });

    expect(result.semantic).toBe(true);
    expect(result.matches.map((match) => match.agentId)).toEqual(["b", "a"]);
  });

  test("the card carries the first run's launch prompt and the latest report", async () => {
    const cards: string[] = [];
    await service({
      agents: [agent("a")],
      // Newest first, as MissionControlService.getRunRecords returns them.
      runs: [
        run("a", "follow-up: ship it", "2026-10-03T00:00:00.000Z", "Shipped to every host"),
        run("a", "build the deploy script", "2026-10-02T00:00:00.000Z", "First draft"),
      ],
      key: "key",
      fetchImpl: jev((card) => {
        cards.push(card);
        return 0;
      }),
    }).search({ query: "deploy" });

    expect(cards[0]).toContain("Launch prompt: build the deploy script");
    expect(cards[0]).toContain("Last report: Shipped to every host");
  });

  test("archived, internal, and machinery agents are candidates only as allowed", async () => {
    const agents = [
      agent("live", { title: "deploy live" }),
      agent("old", { title: "deploy old", archivedAt: "2026-10-05T00:00:00.000Z" }),
      agent("hidden", { title: "deploy hidden", internal: true }),
      agent("commander", {
        title: "deploy commander",
        labels: { "paseo.mission-control": "commander" },
      }),
    ];

    const active = await service({ agents }).search({ query: "deploy" });
    expect(active.matches.map((match) => match.agentId)).toEqual(["live"]);

    const all = await service({ agents }).search({ query: "deploy", includeArchived: true });
    expect(all.matches.map((match) => match.agentId).sort()).toEqual(["live", "old"]);
  });

  test("splits large candidate sets across parallel jev calls and keeps every score aligned", async () => {
    const agents = Array.from({ length: 250 }, (_, index) =>
      agent(`n${index}`, { title: `Task number ${index}` }),
    );
    const calls: string[][] = [];
    const result = await service({
      agents,
      key: "key",
      fetchImpl: jev((card) => (card.endsWith("Task number 207") ? 0.9 : 0), calls),
    }).search({ query: "the 207th task" });

    expect(calls.map((questions) => questions.length)).toEqual([100, 100, 50]);
    expect(result.candidateCount).toBe(250);
    expect(result.matches.map((match) => match.agentId)).toEqual(["n207"]);
  });

  test("a failing jev call falls back to word matches", async () => {
    const result = await service({
      agents: [agent("a", { title: "Fix deploy" }), agent("b", { title: "Other" })],
      key: "key",
      fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    }).search({ query: "deploy" });

    expect(result.semantic).toBe(false);
    expect(result.matches.map((match) => match.agentId)).toEqual(["a"]);
  });
});
