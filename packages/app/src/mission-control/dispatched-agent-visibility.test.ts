import { describe, expect, it } from "vitest";
import { isWorkspaceRootAgent } from "@/subagents/workspace-root-policy";
import { selectWorkspaceOpenState } from "@/mission-control/workspace-open-state";

/**
 * The exact live case that shipped broken three times: a Commander-dispatched
 * worker on the local host, whose Commander runs on a peer.
 *
 * Values are copied from the real records rather than invented:
 *   agent     47c4ac7f-b11b-4f05-ad43-5acb6f4cc3ca ("Erwin" / "Dirac — paseo dev test agent")
 *     archivedAt: null, cwd /Users/vaibhav/paseo, workspaceId wks_04bc75ed85cadbbe
 *     labels["paseo.parent-agent-id"] = cc7ad5b8-... (the Commander, on another host)
 *   workspace wks_04bc75ed85cadbbe ("Paseo Agent Infrastructure and Latency")
 *     archivedAt/archivingAt: null, status "done" (the daemon's IDLE default)
 */
const SERVER_ID = "srv_UATl_VeSDsDe";
const WORKSPACE_ID = "wks_04bc75ed85cadbbe";
const AGENT_ID = "47c4ac7f-b11b-4f05-ad43-5acb6f4cc3ca";
const COMMANDER_ID = "cc7ad5b8-ad2a-4801-a202-79e1d9907cc8";

describe("Commander-dispatched worker, live values", () => {
  it("is a workspace root agent even though its Commander is on another host", () => {
    // The parent record is absent from this host's store, so the policy has no
    // parent workspace to compare against. It used to answer "not a root
    // agent", which hid the agent from its own workspace.
    expect(
      isWorkspaceRootAgent({ parentAgentId: COMMANDER_ID, workspaceId: WORKSPACE_ID }, undefined),
    ).toBe(true);
  });

  it("does not report the idle workspace as archived", () => {
    // status "done" is the daemon's idle default, not an archive marker.
    const state = {
      sessions: {
        [SERVER_ID]: {
          workspaces: new Map([
            [
              WORKSPACE_ID,
              {
                id: WORKSPACE_ID,
                status: "done" as const,
                archivingAt: null,
              },
            ],
          ]),
          hasHydratedWorkspaces: true,
        },
      },
    } as unknown as Parameters<typeof selectWorkspaceOpenState>[0];

    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID)).toEqual({
      isArchived: false,
      isUnavailable: false,
      isArchivedOrMissing: false,
    });
  });

  it("still reports a genuinely archiving workspace as archived", () => {
    const state = {
      sessions: {
        [SERVER_ID]: {
          workspaces: new Map([
            [
              WORKSPACE_ID,
              {
                id: WORKSPACE_ID,
                status: "done" as const,
                archivingAt: "2026-08-12T00:00:00.000Z",
              },
            ],
          ]),
          hasHydratedWorkspaces: true,
        },
      },
    } as unknown as Parameters<typeof selectWorkspaceOpenState>[0];

    expect(selectWorkspaceOpenState(state, SERVER_ID, WORKSPACE_ID).isArchived).toBe(true);
  });

  it("names the agent whose id this test pins", () => {
    // Guards against the fixture drifting into a meaningless placeholder.
    expect(AGENT_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});
