import { describe, expect, test } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// Voice P0 instruction ledger (spec 05): the open RPC records one ledger row
// per final voice utterance; the list RPC surfaces rows; a citing card
// (respondsTo) closes the row at creation — emit-time close. The voice node
// re-injects still-open rows every turn ("Open: #12 …").
describe("mission_control.instructions.open (voice P0 ledger)", () => {
  test("open -> list -> close-on-card over the wire", { timeout: 60_000 }, async () => {
    const daemon: TestPaseoDaemon = await createTestPaseoDaemon();
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.82",
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "instructions-open-test" } });

      // Open one row per utterance; ids are short and monotonic.
      const first = await client.missionControlInstructionsOpen({
        text: "spawn worker in paseo",
        source: "voice",
      });
      expect(first.instructions).toEqual([{ id: "#1", text: "spawn worker in paseo" }]);

      const second = await client.missionControlInstructionsOpen({
        text: "status of Keen Heisenberg",
        source: "voice",
      });
      expect(second.instructions).toEqual([{ id: "#2", text: "status of Keen Heisenberg" }]);

      // List: both rows open, source voice, no closedBy while open.
      const listed = await client.missionControlInstructionsList();
      expect(listed.instructions).toHaveLength(2);
      const byId = new Map(listed.instructions.map((instruction) => [instruction.id, instruction]));
      expect(byId.get("#1")).toMatchObject({
        id: "#1",
        text: "spawn worker in paseo",
        status: "open",
        source: "voice",
      });
      expect("closedBy" in byId.get("#1")).toBe(false);
      expect(byId.get("#2")).toMatchObject({
        id: "#2",
        text: "status of Keen Heisenberg",
        status: "open",
        source: "voice",
      });

      // Close-on-card: a citing proposal card (respondsTo "#1") closes the
      // row the moment the card is created — the same emit-time close the
      // voice node's direct-mode cards ride.
      const exec = await client.missionControlToolsExecute({
        name: "fleet_create_agent",
        args: {
          host: "local",
          provider: "claude/test-model",
          title: "answer instruction #1",
          initialPrompt: "answer instruction #1",
          respondsTo: "#1",
        },
      });
      expect(exec.ok).toBe(true);

      const after = await client.missionControlInstructionsList();
      const afterById = new Map(
        after.instructions.map((instruction) => [instruction.id, instruction]),
      );
      expect(afterById.get("#1")?.status).toBe("closed");
      expect(afterById.get("#1")?.closedBy).toBe("cardId");
      // The uncited row stays open — it resurfaces until answered.
      expect(afterById.get("#2")?.status).toBe("open");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
    }
  });
});
