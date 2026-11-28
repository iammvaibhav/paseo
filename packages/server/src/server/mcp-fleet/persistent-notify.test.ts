import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { PersistentNotifyEntry } from "@getpaseo/protocol/messages";
import type { ForegroundTurnStart } from "../agent/agent-manager.js";
import { createPersistentNotify } from "./persistent-notify.js";

function setup(stored: PersistentNotifyEntry[] = []) {
  let entries = stored;
  const listeners = new Set<(start: ForegroundTurnStart) => void>();
  const armed: Array<{ turnId: string; target: PersistentNotifyEntry["target"] }> = [];
  let activeTurnId: string | null = null;
  const subject = createPersistentNotify({
    agentManager: {
      onForegroundTurnStarted: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getAgent: () =>
        ({ activeForegroundTurnId: activeTurnId }) as unknown as ReturnType<
          Parameters<typeof createPersistentNotify>[0]["agentManager"]["getAgent"]
        >,
    },
    agentStorage: {
      get: async () => ({ persistentNotify: entries }) as never,
      setPersistentNotify: async (_agentId, next) => {
        entries = next;
      },
    },
    isConfigured: (name) => name === "n8n-wren" || name === "grok-bot",
    arm: (_agentId, turnId, entry) => armed.push({ turnId, target: entry.target }),
    logger: pino({ level: "silent" }),
  });
  const startTurn = async (turnId: string, origin: ForegroundTurnStart["origin"]) => {
    activeTurnId = turnId;
    for (const listener of listeners) listener({ agentId: "wren", turnId, origin });
    // The listener reads storage before it arms; let that settle.
    await sleep(0);
  };
  return { subject, armed, startTurn, entries: () => entries };
}

describe("createPersistentNotify", () => {
  it("arms each turn for the entries whose turns include what started it", async () => {
    const { subject, armed, startTurn } = setup([
      { target: "n8n-wren" },
      { target: "grok-bot", turns: ["app", "reminder"] },
      { target: { agent: "boss-1" }, turns: ["callback"] },
    ]);
    const stop = subject.start();
    await startTurn("t-callback", "callback");
    await startTurn("t-app", "app");
    await startTurn("t-prompt", "prompt");
    stop();
    await startTurn("t-after-stop", "prompt");
    expect(armed).toEqual([
      { turnId: "t-callback", target: "n8n-wren" },
      { turnId: "t-callback", target: { agent: "boss-1" } },
      { turnId: "t-app", target: "n8n-wren" },
      { turnId: "t-app", target: "grok-bot" },
      { turnId: "t-prompt", target: "n8n-wren" },
    ]);
  });

  it("a set covers the turn running now, by that turn's origin", async () => {
    const { subject, armed, startTurn, entries } = setup();
    subject.start();
    await startTurn("t-1", "callback");
    await subject.set("wren", [
      { target: "n8n-wren", turns: ["callback"] },
      { target: "grok-bot", turns: ["app"] },
    ]);
    expect(entries()).toHaveLength(2);
    expect(armed).toEqual([{ turnId: "t-1", target: "n8n-wren" }]);
  });

  it("refuses entries that could never deliver, storing nothing", async () => {
    const { subject, entries } = setup();
    await expect(subject.set("wren", [{ target: "nobody" }])).rejects.toThrow("not configured");
    await expect(subject.set("wren", [{ target: { agent: "wren" } }])).rejects.toThrow(
      "its own persistent target",
    );
    await expect(
      subject.set("wren", [{ target: "n8n-wren" }, { target: "n8n-wren", context: "x" }]),
    ).rejects.toThrow("listed twice");
    expect(entries()).toEqual([]);
  });
});
