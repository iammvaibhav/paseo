import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { runNudge, runSnapshot } from "./deploy-nudge.mjs";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("snapshot records running provider subagents for later nudge", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deploy-nudge-snapshot-"));
  createdDirs.push(dir);
  const snapshotFile = path.join(dir, "running.json");
  const listed: string[] = [];
  const client = {
    fetchAgents: async () => ({
      entries: [
        { agent: { id: "parent-1", title: "Orchestrator", status: "running" } },
        { agent: { id: "idle-1", title: "Idle", status: "idle" } },
      ],
    }),
    listProviderSubagents: async (parentAgentId: string) => {
      listed.push(parentAgentId);
      return {
        subagents: [
          { id: "child-a", title: "InvestigateGhostAgent", status: "running" },
          { id: "child-b", title: "Done", status: "completed" },
        ],
      };
    },
    close: async () => undefined,
  };

  await runSnapshot(client, snapshotFile, "snapshot");

  expect(listed).toEqual(["parent-1"]);
  expect(JSON.parse(await readFile(snapshotFile, "utf8"))).toEqual([
    {
      id: "parent-1",
      title: "Orchestrator",
      runningSubagents: [{ id: "child-a", title: "InvestigateGhostAgent" }],
    },
  ]);
});

test("nudge names interrupted subagents by id and tells the parent to revive them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deploy-nudge-nudge-"));
  createdDirs.push(dir);
  const snapshotFile = path.join(dir, "running.json");
  await writeFile(
    snapshotFile,
    `${JSON.stringify(
      [
        {
          id: "parent-1",
          title: "Orchestrator",
          runningSubagents: [{ id: "child-a", title: "InvestigateGhostAgent" }],
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );
  const sent: Array<{ id: string; message: string }> = [];
  const client = {
    sendAgentMessage: async (id: string, message: string) => {
      sent.push({ id, message });
    },
    close: async () => undefined,
  };

  await runNudge(client, snapshotFile, undefined, "nudge");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.id).toBe("parent-1");
  expect(sent[0]?.message).toContain("[child-a]");
  expect(sent[0]?.message).not.toContain("InvestigateGhostAgent");
  expect(sent[0]?.message).toContain("parked");
  expect(sent[0]?.message).toContain("Do not re-launch them");
  expect(sent[0]?.message).toContain("check what it already changed before you repeat it");
});
