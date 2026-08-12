import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { CentralMissionControlConfigStore } from "./config.js";
import { createMissionControlPresenceSource } from "./presence.js";
import { MissionControlService } from "./service.js";
import { MISSION_CONTROL_LABEL_KEY, MISSION_CONTROL_LABEL_VALUE } from "./commander-contract.js";

describe("MissionControlService voice mirror (M9)", () => {
  let dir: string;
  let service: MissionControlService;
  let appendTimelineItem: Mock;
  let streamAgent: Mock;

  async function createService(
    options: {
      seedCommander?: boolean;
    } = {},
  ): Promise<void> {
    appendTimelineItem = vi.fn(async () => undefined);
    streamAgent = vi.fn(async function* () {});
    const storageRecords = options.seedCommander
      ? [
          {
            id: "commander-1",
            labels: {
              [MISSION_CONTROL_LABEL_KEY]: MISSION_CONTROL_LABEL_VALUE,
            } as Record<string, string>,
          },
        ]
      : [];
    const store = new CentralMissionControlConfigStore({
      paseoHome: dir,
      logger: createTestLogger(),
    });
    await store.initialize();
    service = new MissionControlService({
      paseoHome: dir,
      logger: createTestLogger(),
      agentManager: {
        getAgent: () => null,
        listAgents: () => [],
        appendTimelineItem,
        hasInFlightRun: () => false,
        subscribe: vi.fn(() => () => {}),
        streamAgent,
      } as unknown as AgentManager,
      agentStorage: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => storageRecords),
        upsert: vi.fn(async () => undefined),
      } as unknown as AgentStorage,
      daemonConfigStore: { get: () => ({}) } as unknown as DaemonConfigStore,
      serverId: "test-server",
      hostName: "host-a",
      broadcast: vi.fn(),
      presence: createMissionControlPresenceSource({
        isAgentFocused: () => false,
        readStopOrigin: () => null,
      }),
      centralConfig: store,
    });
    await service.start();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-voice-mirror-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("appends a user qa row to the Commander timeline WITHOUT running a model turn", async () => {
    await createService({ seedCommander: true });
    const result = await service.mirrorVoiceTurn({
      role: "user",
      text: "What is Archimedes doing?",
      kind: "qa",
    });
    expect(result).toEqual({ ok: true });
    // The append landed on the Commander agent with the voice marker.
    expect(appendTimelineItem).toHaveBeenCalledTimes(1);
    expect(appendTimelineItem).toHaveBeenCalledWith("commander-1", {
      type: "user_message",
      text: "What is Archimedes doing?",
      voiceMirrorKind: "qa",
    });
    // No model turn: nothing was streamed, steered, or prompted.
    expect(streamAgent).not.toHaveBeenCalled();
  });

  test("appends an assistant dispatch row with role/kind preserved", async () => {
    await createService({ seedCommander: true });
    const result = await service.mirrorVoiceTurn({
      role: "assistant",
      text: "On it — dispatching the spawn to Commander.",
      kind: "dispatch",
    });
    expect(result).toEqual({ ok: true });
    expect(appendTimelineItem).toHaveBeenCalledWith("commander-1", {
      type: "assistant_message",
      text: "On it — dispatching the spawn to Commander.",
      voiceMirrorKind: "dispatch",
    });
    expect(streamAgent).not.toHaveBeenCalled();
  });

  test("fails cleanly when no Commander agent exists on this host", async () => {
    await createService({ seedCommander: false });
    const result = await service.mirrorVoiceTurn({
      role: "user",
      text: "nudge Pia",
      kind: "dispatch",
    });
    expect(result).toEqual({ ok: false, error: "No Commander agent on this host" });
    expect(appendTimelineItem).not.toHaveBeenCalled();
    expect(streamAgent).not.toHaveBeenCalled();
  });
});
