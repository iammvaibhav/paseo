/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";
import { ProofSections } from "./proof-sections";

const { mediaFetchMock, theme, fakeClient } = vi.hoisted(() => {
  const fetchMock = vi.fn();
  const client = {
    missionControlMediaFetch: (...args: unknown[]) => fetchMock(...args),
  };
  return {
    mediaFetchMock: fetchMock,
    fakeClient: client,
    theme: {
      colors: {
        foreground: "#111111",
        foregroundMuted: "#666666",
        foregroundExtraMuted: "#999999",
        surface0: "#ffffff",
        surface1: "#fafafa",
        surface2: "#f4f4f5",
        border: "#e4e4e7",
        accent: "#2563eb",
        destructive: "#b91c1c",
        success: "#15803d",
      },
      spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
      fontFamily: { ui: "sans-serif", mono: "monospace" },
      fontSize: { xs: 12, sm: 14, base: 15 },
      fontWeight: { normal: "400", medium: "500" },
      borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      (typeof factory === "function" ? factory(theme) : factory) as object,
  },
  withUnistyles: (Component: unknown) => Component,
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => null,
  ChevronRight: () => null,
}));

vi.mock("@/components/ui/external-link", () => ({
  ExternalLink: (props: { href: string; label: string }) =>
    React.createElement("a", { href: props.href }, props.label),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": { client: fakeClient },
      },
    }),
}));

vi.mock("expo-image", () => ({
  Image: (props: { testID?: string; source?: { uri?: string } }) =>
    React.createElement("div", {
      "data-testid": props.testID,
      "data-uri": props.source?.uri ?? "",
    }),
}));

function imageProof(overrides: Partial<MissionControlProof> = {}): MissionControlProof {
  return { kind: "image", path: "/tmp/shot.png", label: "Screenshot", ...overrides };
}

function videoProof(overrides: Partial<MissionControlProof> = {}): MissionControlProof {
  return { kind: "video", path: "/tmp/clip.mp4", label: "Demo", ...overrides };
}

function codeProof(kind: "code" | "api", excerpt: string): MissionControlProof {
  return { kind, excerpt };
}

function prProof(): MissionControlProof {
  return { kind: "pr", url: "https://github.com/getpaseo/paseo/pull/12", label: "PR #12" };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  // jsdom's media resource loader does not handle blob: URLs; stub them so
  // the <video> element does not try (and hang on) a network load.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:proof-test",
    revokeObjectURL: () => undefined,
  });
});

function mount(proofs: MissionControlProof[]): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ProofSections proofs={proofs} serverId="server-1" />);
  });
}

function expandHeader(label: string): void {
  const header = [...document.querySelectorAll("[role=button]")].find((el) =>
    el.textContent?.includes(label),
  );
  expect(header).toBeTruthy();
  act(() => {
    header!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  mediaFetchMock.mockReset();
  mediaFetchMock.mockImplementation(async ({ path }: { path: string }) => {
    if (path.endsWith(".mp4")) {
      return {
        requestId: "req_video",
        ok: true,
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        sizeBytes: 12,
        data: Buffer.from("fakemp4bytes").toString("base64"),
      };
    }
    return {
      requestId: "req_img",
      ok: true,
      mimeType: "image/png",
      fileName: "shot.png",
      sizeBytes: 4,
      data: Buffer.from("hi!").toString("base64"),
    };
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("ProofSections", () => {
  it("renders collapsed sections with kind headers and hides bodies", () => {
    mount([imageProof(), codeProof("code", "const x = 1;"), prProof()]);

    expect(document.body.textContent).toContain("Image proof");
    expect(document.body.textContent).toContain("Code proof");
    expect(document.body.textContent).toContain("PR");
    expect(document.querySelector('[data-testid="mission-control-proof-image"]')).toBeNull();
    expect(document.body.textContent).not.toContain("const x = 1;");
    // PR chips are inside the collapsed section too.
    expect(document.body.textContent).not.toContain("PR #12");
  });

  it("expands PR sections into chip links", () => {
    mount([prProof()]);

    expandHeader("PR");
    const link = document.querySelector('a[href="https://github.com/getpaseo/paseo/pull/12"]');
    expect(link).toBeTruthy();
    expect(link!.textContent).toBe("PR #12");
  });

  it("expands image proofs through the media RPC and renders the image", async () => {
    mount([imageProof()]);

    expandHeader("Image proof");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mediaFetchMock).toHaveBeenCalledWith({ host: "local", path: "/tmp/shot.png" });
    const image = document.querySelector('[data-testid="mission-control-proof-image"]');
    expect(image).toBeTruthy();
    expect(image!.getAttribute("data-uri")).toBe(
      `data:image/png;base64,${Buffer.from("hi!").toString("base64")}`,
    );
  });

  it("renders code and api excerpts as code blocks when expanded", () => {
    mount([
      codeProof("code", "function add(a, b) { return a + b; }"),
      codeProof("api", "GET /health 200"),
    ]);

    const headers = [...document.querySelectorAll("[role=button]")];
    act(() => {
      headers[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("function add(a, b) { return a + b; }");
    expect(document.body.textContent).not.toContain("GET /health 200");

    act(() => {
      headers[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("GET /health 200");
  });

  it("renders a video element with a blob src when expanded", async () => {
    mount([videoProof()]);

    expandHeader("Video proof");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mediaFetchMock).toHaveBeenCalledWith({ host: "local", path: "/tmp/clip.mp4" });
    const video = document.querySelector('video[data-testid="mission-control-proof-video"]');
    expect(video).toBeTruthy();
    expect(video!.getAttribute("src")).toMatch(/^blob:/);
    expect(video!.hasAttribute("controls")).toBe(true);
  });

  it("keeps legacy diff/command proofs as chips", () => {
    mount([
      { kind: "diff", additions: 3, deletions: 1 },
      { kind: "command", label: "npm test", exitCode: 0 },
    ]);

    expect(document.body.textContent).toContain("+3");
    expect(document.body.textContent).toContain("−1");
    expect(document.body.textContent).toContain("npm test · exit 0");
    expect(document.body.textContent).not.toContain("Image proof");
  });
});
