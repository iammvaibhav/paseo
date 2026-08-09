/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SessionStore's workspace activity index consults History Ask. The real
// History Ask barrel pulls the draft store back into SessionStore and schedules
// attachment GC during module evaluation; this focused selector test does not
// exercise that subsystem.
vi.mock("@/history-ask", () => ({ isHistoryAskAgent: () => false }));
import {
  buildHostInfoByServerId,
  resolveCommanderServerId,
  useHostInfoByServerId,
  type HostInfoByServerId,
} from "./commander-host";
import { useSessionStore, type DaemonServerInfo } from "@/stores/session-store";

const SERVER_ID = "commander-host-test-server";

const serverInfo = (partial: Partial<DaemonServerInfo>): DaemonServerInfo => ({
  serverId: SERVER_ID,
  hostname: null,
  missionControlHostAlias: null,
  version: null,
  ...partial,
});

function seedSession(info: DaemonServerInfo | null): void {
  const state = useSessionStore.getState();
  if (!state.sessions[SERVER_ID]) {
    state.initializeSession(SERVER_ID, null);
  }
  if (info) {
    state.updateSessionServerInfo(SERVER_ID, info);
  }
}

describe("buildHostInfoByServerId", () => {
  it("extracts hostname and missionControlHostAlias per server, defaulting to null", () => {
    expect(
      buildHostInfoByServerId({
        "srv-a": { serverInfo: { hostname: "daemon-a", missionControlHostAlias: "alias-a" } },
        "srv-b": { serverInfo: null },
        "srv-c": {
          serverInfo: { hostname: "daemon-c", missionControlHostAlias: null },
        },
      }),
    ).toEqual({
      "srv-a": { hostname: "daemon-a", hostAlias: "alias-a" },
      "srv-b": { hostname: null, hostAlias: null },
      "srv-c": { hostname: "daemon-c", hostAlias: null },
    });
  });
});

describe("resolveCommanderServerId", () => {
  const hosts = [{ serverId: "srv-a" }, { serverId: "srv-b" }];
  const hostInfoByServerId: HostInfoByServerId = {
    "srv-a": { hostname: "daemon-a", hostAlias: "alias-a" },
    "srv-b": { hostname: "daemon-b", hostAlias: null },
  };

  it("returns null when there is no central commanderHost designation", () => {
    expect(resolveCommanderServerId(null, hosts, hostInfoByServerId)).toBeNull();
  });

  it("resolves directly by serverId before consulting server_info", () => {
    expect(resolveCommanderServerId("srv-b", hosts, hostInfoByServerId)).toBe("srv-b");
  });

  it("resolves by server_info hostname", () => {
    expect(resolveCommanderServerId("daemon-a", hosts, hostInfoByServerId)).toBe("srv-a");
  });

  it("resolves by missionControlHostAlias", () => {
    expect(resolveCommanderServerId("alias-a", hosts, hostInfoByServerId)).toBe("srv-a");
  });

  it("never matches a null hostAlias, even when another field matches elsewhere", () => {
    // "srv-b" has hostAlias null: designating a value that is only its alias
    // is impossible, and the null guard must not short-circuit into a match.
    expect(resolveCommanderServerId("alias-b", hosts, hostInfoByServerId)).toBeNull();
  });

  it("returns null when no host matches by serverId, hostname, or alias", () => {
    expect(resolveCommanderServerId("unknown-host", hosts, hostInfoByServerId)).toBeNull();
  });
});

describe("useHostInfoByServerId", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seedSession(serverInfo({ hostname: "daemon-a", missionControlHostAlias: "alias-a" }));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    errorSpy.mockRestore();
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("returns the same map reference across consecutive reads over unchanged state", async () => {
    const reads: Array<HostInfoByServerId> = [];
    function Probe() {
      reads.push(useHostInfoByServerId());
      return null;
    }

    await act(async () => {
      root?.render(<Probe />);
    });
    expect(reads.length).toBeGreaterThan(0);
    const first = reads[0];
    expect(first).toEqual({
      [SERVER_ID]: { hostname: "daemon-a", hostAlias: "alias-a" },
    });

    // Parent re-render with no store change: getSnapshot is read again and
    // must yield the same selected reference (React 19 would otherwise warn
    // "The result of getSnapshot should be cached" and loop).
    await act(async () => {
      root?.render(<Probe />);
    });
    expect(reads.at(-1)).toBe(first);

    // A store notification that leaves the sessions record untouched must not
    // move the reference either.
    act(() => {
      useSessionStore.setState({ ...useSessionStore.getState() });
    });
    await act(async () => {
      root?.render(<Probe />);
    });
    expect(reads.at(-1)).toBe(first);

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("The result of getSnapshot should be cached"),
    );
  });
});
