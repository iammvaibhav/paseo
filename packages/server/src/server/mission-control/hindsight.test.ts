import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { HindsightClient, buildRunRecordContent } from "./hindsight.js";
import { runRecordTags } from "./run-records.js";
import type { MissionControlRunRecord } from "./run-records.js";

function runRecord(overrides: Partial<MissionControlRunRecord> = {}): MissionControlRunRecord {
  return {
    id: "mcr_agent-1_1",
    agentId: "agent-1",
    agentName: "Rusty",
    agentTitle: "Rusty",
    hostAlias: "work-server",
    serverId: "server-1",
    workspaceId: "ws-1",
    workspaceTitle: "mission-control",
    projectId: "proj-1",
    projectName: "paseo",
    runEpoch: 1,
    startedAt: "2026-08-09T09:00:00.000Z",
    endedAt: "2026-08-09T10:00:00.000Z",
    outcome: "finished",
    brief: "Ship run records for M6",
    reports: [
      {
        ts: "2026-08-09T09:30:00.000Z",
        kind: "finding",
        headline: "Decided: key by runEpoch",
        reportKind: "decision",
      },
    ],
    verdict: null,
    proofs: [{ kind: "url", url: "https://example.com/proof", label: "CI green" }],
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  } as MissionControlRunRecord;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("M6 Hindsight fleet bank client", () => {
  test("writeRunRecord PUTs the bank once and POSTs the memory with host/project/workspace/agent tags", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "PUT") {
        return jsonResponse({ bank_id: "paseo-fleet-dev" });
      }
      return jsonResponse({ items: [{ id: "mem-1" }] });
    }) as unknown as typeof fetch;

    const client = new HindsightClient({ logger: createTestLogger(), fetchImpl });
    await client.writeRunRecord({
      url: "http://hindsight.test:8890",
      bank: "paseo-fleet-dev",
      record: runRecord(),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://hindsight.test:8890/v1/default/banks/paseo-fleet-dev");
    expect(calls[0].init.method).toBe("PUT");
    const memory = JSON.parse(String(calls[1].init.body)) as {
      items: Array<{ content: string; tags: string[]; document_id: string; timestamp: string }>;
    };
    expect(calls[1].url).toBe(
      "http://hindsight.test:8890/v1/default/banks/paseo-fleet-dev/memories",
    );
    expect(memory.items).toHaveLength(1);
    expect(memory.items[0].tags).toEqual([
      "host:work-server",
      "agent:Rusty",
      "project:paseo",
      "workspace:mission-control",
    ]);
    expect(memory.items[0].document_id).toBe("paseo-run:agent-1:1");
    expect(memory.items[0].content).toContain("Decided: key by runEpoch");
    // The bank is ensured only once across writes.
    await client.writeRunRecord({
      url: "http://hindsight.test:8890",
      bank: "paseo-fleet-dev",
      record: runRecord(),
    });
    expect(calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
  });

  test("writeRunRecord swallows failures (never throws) with a throttled log", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const logger = createTestLogger();
    const warnSpy = vi.spyOn(logger, "warn");
    const client = new HindsightClient({ logger, fetchImpl, logIntervalMs: 60_000 });

    await expect(
      client.writeRunRecord({
        url: "http://hindsight.test:8890",
        bank: "paseo-fleet-dev",
        record: runRecord(),
      }),
    ).resolves.toBeUndefined();
    // Second failure within the interval logs nothing (once per interval).
    await client.writeRunRecord({
      url: "http://hindsight.test:8890",
      bank: "paseo-fleet-dev",
      record: runRecord(),
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("recall returns matches on success and memory-unavailable on failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            id: "mem-9",
            text: "Rusty fixed the auth bug (run mcr_agent-1_1)",
            document_id: "paseo-run:agent-1:1",
            tags: ["host:work-server", "agent:Rusty"],
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const client = new HindsightClient({ logger: createTestLogger(), fetchImpl });
    const result = await client.recall({
      url: "http://hindsight.test:8890",
      bank: "paseo-fleet-dev",
      query: "who fixed the auth bug",
    });
    expect(result).toEqual({
      ok: true,
      matches: [
        {
          id: "mem-9",
          text: "Rusty fixed the auth bug (run mcr_agent-1_1)",
          context: null,
          occurredStart: null,
          documentId: "paseo-run:agent-1:1",
          tags: ["host:work-server", "agent:Rusty"],
        },
      ],
    });

    const failing = new HindsightClient({
      logger: createTestLogger(),
      fetchImpl: (async () => {
        throw new Error("timeout");
      }) as unknown as typeof fetch,
    });
    const unavailable = await failing.recall({
      url: "http://hindsight.test:8890",
      bank: "paseo-fleet-dev",
      query: "anything",
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.reason).toBe("memory unavailable");
    }
  });

  test("HindsightClient.isEnabled gates on a non-empty configured URL", () => {
    expect(HindsightClient.isEnabled(null)).toBe(false);
    expect(HindsightClient.isEnabled(undefined)).toBe(false);
    expect(HindsightClient.isEnabled("   ")).toBe(false);
    expect(HindsightClient.isEnabled("http://hindsight.test:8890")).toBe(true);
  });

  test("buildRunRecordContent renders the recallable text (brief + reports + verdict + proofs)", () => {
    const content = buildRunRecordContent(
      runRecord({
        verdict: {
          by: "verifier",
          summary: "Proofs match the brief",
          at: "2026-08-09T10:05:00.000Z",
        },
      }),
    );
    expect(content).toContain("Paseo run record: Rusty");
    expect(content).toContain("Brief: Ship run records for M6");
    expect(content).toContain("decision: Decided: key by runEpoch");
    expect(content).toContain("Verdict (verifier): Proofs match the brief");
    expect(content).toContain("Proofs: CI green (https://example.com/proof)");
  });

  test("runRecordTags omit project/workspace tags when attribution is missing", () => {
    const tags = runRecordTags(runRecord({ projectName: null, workspaceTitle: null }));
    expect(tags).toEqual(["host:work-server", "agent:Rusty"]);
  });
});
