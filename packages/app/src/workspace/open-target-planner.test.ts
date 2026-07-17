import { describe, expect, it } from "vitest";
import { planWorkspaceOpenTargets } from "./open-target-planner";

const desktopTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
  },
];

const checkoutStatus = {
  isGit: true,
  remoteUrl: "git@github.com:getpaseo/paseo.git",
  currentBranch: "main",
};

describe("planWorkspaceOpenTargets", () => {
  it("plans editor targets with active-file absolute path and cwd", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "vscode",
      openInput: {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 3,
      },
    });
  });

  it("plans file-manager targets with active-file absolute path and reveal mode", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[1]).toMatchObject({
      source: "desktop",
      id: "finder",
      openInput: {
        editorId: "finder",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
      },
    });
  });

  it("plans no active file as opening the workspace folder", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "vscode",
      openInput: { editorId: "vscode", workspacePath: "/repo" },
    });
    expect(targets[1]).toMatchObject({
      source: "desktop",
      id: "finder",
      openInput: { editorId: "finder", workspacePath: "/repo" },
    });
  });

  it("passes custom target ids through as strings", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets: [
        {
          id: "script:open-in-nvim",
          label: "Open in Neovim",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets).toEqual([
      {
        source: "desktop",
        id: "script:open-in-nvim",
        label: "Open in Neovim",
        editorId: "script:open-in-nvim",
        icon: { kind: "symbol", name: "terminal" },
        openInput: {
          editorId: "script:open-in-nvim",
          workspacePath: "/repo",
          filePath: "/repo/src/app.ts",
        },
      },
    ]);
  });

  it("keeps GitHub target independent and uses blob and tree URLs", () => {
    const blobTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus,
    });
    const treeTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus,
    });

    expect(blobTargets).toEqual([
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/blob/main/src/app.ts#L3-L5",
      },
    ]);
    expect(treeTargets).toEqual([
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/tree/main",
      },
    ]);
  });

  it("infers the forge from the remote URL when the forge input is null", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus: {
        isGit: true,
        remoteUrl: "git@gitlab.com:group/project.git",
        currentBranch: "main",
      },
      forge: null,
    });

    expect(targets).toEqual([
      {
        source: "forge",
        forge: "gitlab",
        id: "gitlab",
        label: "GitLab",
        url: "https://gitlab.com/group/project/-/blob/main/src/app.ts#L3-5",
      },
    ]);
  });

  it("suppresses desktop targets when Electron bridge is unavailable", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: false,
      isLocalExecution: true,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("suppresses desktop targets for remote execution paths", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: false,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("plans remote-capable editors with sshHost when the host has one configured", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets: [
        { id: "cursor", label: "Cursor", kind: "editor", supportsRemote: true },
        { id: "vscode", label: "VS Code", kind: "editor", supportsRemote: true },
        { id: "webstorm", label: "WebStorm", kind: "editor" },
        { id: "finder", label: "Finder", kind: "file-manager" },
      ],
      canUseDesktopBridge: true,
      isLocalExecution: false,
      remoteSshHost: "vaibhav@dev-box",
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["cursor", "vscode", "github"]);
    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "cursor",
      openInput: {
        editorId: "cursor",
        path: "/repo/src/app.ts",
        cwd: "/repo",
        sshHost: "vaibhav@dev-box",
      },
    });
  });

  it("plans remote workspace folder open without an active file", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: [{ id: "cursor", label: "Cursor", kind: "editor", supportsRemote: true }],
      canUseDesktopBridge: true,
      isLocalExecution: false,
      remoteSshHost: "dev-box",
    });

    expect(targets).toEqual([
      {
        source: "desktop",
        id: "cursor",
        label: "Cursor",
        editorId: "cursor",
        openInput: { editorId: "cursor", path: "/repo", sshHost: "dev-box" },
      },
    ]);
  });

  it("does not attach sshHost to local execution targets", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
      remoteSshHost: "dev-box",
    });

    const first = targets[0];
    expect(first).toMatchObject({
      source: "desktop",
      openInput: { editorId: "vscode", workspacePath: "/repo" },
    });
    if (first?.source !== "desktop") throw new Error("expected desktop target");
    expect(first.openInput.sshHost).toBeUndefined();
  });

  it("plans VS Code Web when a browserEditorUrl is configured", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/home/vaibhav/paseo",
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      browserEditorUrl: "http://blrofc3:8765",
    });

    expect(targets).toEqual([
      {
        source: "browser-editor",
        id: "vscode-web",
        label: "VS Code Web",
        url: "http://blrofc3:8765/?folder=%2Fhome%2Fvaibhav%2Fpaseo",
      },
    ]);
  });

  it("keeps VS Code Web alongside remote desktop editors", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: [
        { id: "cursor", label: "Cursor", kind: "editor", supportsRemote: true },
        { id: "vscode", label: "VS Code", kind: "editor", supportsRemote: true },
        { id: "finder", label: "Finder", kind: "file-manager" },
      ],
      canUseDesktopBridge: true,
      isLocalExecution: false,
      remoteSshHost: "blrofc3",
      browserEditorUrl: "http://blrofc3:8765",
    });

    expect(targets.map((target) => target.id)).toEqual(["cursor", "vscode", "vscode-web"]);
  });
});
