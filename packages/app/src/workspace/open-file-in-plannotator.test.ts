import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(() => true),
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: vi.fn(() => ({
    browser: {
      preparePlannotator: vi.fn(async ({ remoteUrl }: { remoteUrl: string }) => ({
        url: remoteUrl,
        accelerated: false,
      })),
      releasePlannotator: vi.fn(),
    },
  })),
}));

vi.mock("@/desktop/browser/store", () => ({
  createBrowserId: vi.fn(() => "browser-1"),
  createWorkspaceBrowser: vi.fn(),
  getBrowserRecord: vi.fn(() => null),
  useBrowserStore: {
    getState: vi.fn(() => ({ updateBrowser: vi.fn() })),
  },
}));
import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import {
  isPlannotatorAnnotatableFile,
  tryOpenReviewInPlannotator,
  type PlannotatorSessionClient,
} from "./open-file-in-plannotator";

describe("isPlannotatorAnnotatableFile", () => {
  it.each([
    "README.md",
    "plan.mdx",
    "notes.txt",
    "page.html",
    "config.yaml",
    "package.json",
    "settings.toml",
    "server.log",
    ".env.example",
  ])("accepts %s", (path) => {
    expect(isPlannotatorAnnotatableFile(path)).toBe(true);
  });

  it.each(["app.ts", "main.py", "image.png", ".env"])("rejects %s", (path) => {
    expect(isPlannotatorAnnotatableFile(path)).toBe(false);
  });
});

type StartSessionMock = Mock<PlannotatorSessionClient["startPlannotatorSession"]>;

function createClientStub(): {
  client: PlannotatorSessionClient;
  startPlannotatorSession: StartSessionMock;
} {
  const startPlannotatorSession: StartSessionMock = vi.fn(async () => ({
    sessionId: "session-1",
    port: 19432,
    url: "http://127.0.0.1:19432",
  }));
  return {
    client: { startPlannotatorSession, stopPlannotatorSession: vi.fn(async () => {}) },
    startPlannotatorSession,
  };
}

function createReviewInput(client: PlannotatorSessionClient) {
  return {
    client,
    workspaceDirectory: "/repo",
    workspaceKey: "ws-key",
    workspaceTabs: [],
    openWorkspaceTabFocused: vi.fn(() => "tab-1"),
    navigateToTabId: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(getIsElectron).mockReturnValue(true);
  vi.mocked(createWorkspaceBrowser).mockClear();
  vi.mocked(useBrowserStore.getState).mockReturnValue({
    updateBrowser: vi.fn(),
  } as never);
});

describe("tryOpenReviewInPlannotator", () => {
  it("skips without starting a session when not in Electron", async () => {
    vi.mocked(getIsElectron).mockReturnValue(false);
    const { client, startPlannotatorSession } = createClientStub();

    const result = await tryOpenReviewInPlannotator(createReviewInput(client));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_electron");
    }
    expect(startPlannotatorSession).not.toHaveBeenCalled();
  });

  it("starts a working-tree review session and opens an embedded tab", async () => {
    const { client, startPlannotatorSession } = createClientStub();
    const input = createReviewInput(client);

    const result = await tryOpenReviewInPlannotator(input);

    expect(result.ok).toBe(true);
    expect(startPlannotatorSession).toHaveBeenCalledTimes(1);
    const payload = startPlannotatorSession.mock.calls[0][0];
    expect(payload.kind).toBe("review");
    expect(payload.workspaceDir).toBe("/repo");
    expect(payload.workspaceKey).toBe("ws-key");
    expect(payload.path).toBeUndefined();
    expect(payload.prUrl).toBeUndefined();
    expect(createWorkspaceBrowser).toHaveBeenCalledTimes(1);
    expect(input.openWorkspaceTabFocused).toHaveBeenCalledTimes(1);
    expect(input.navigateToTabId).toHaveBeenCalledWith("tab-1");
  });

  it("passes a PR URL through to the session start", async () => {
    const { client, startPlannotatorSession } = createClientStub();

    const result = await tryOpenReviewInPlannotator({
      ...createReviewInput(client),
      prUrl: "https://git.dev/o/r/pull/7",
    });

    expect(result.ok).toBe(true);
    const payload = startPlannotatorSession.mock.calls[0][0];
    expect(payload.kind).toBe("review");
    expect(payload.prUrl).toBe("https://git.dev/o/r/pull/7");
  });
});
