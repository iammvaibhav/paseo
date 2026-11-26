import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readStoredUpload } from "../file-upload/index.js";
import {
  buildAgentBranchNameSeed,
  buildAgentPrompt,
  renderPromptAttachmentAsText,
  storePromptImages,
} from "./prompt-attachments.js";

describe("prompt attachments", () => {
  it("places fork history before the new user prompt", () => {
    const chatHistory = {
      type: "text" as const,
      mimeType: "text/plain",
      contextKind: "chat_history" as const,
      title: "Chat history",
      text: "<chat-history-summary>\nPrevious work\n</chat-history-summary>",
    };
    const issue = {
      type: "github_issue" as const,
      mimeType: "application/github-issue",
      number: 55,
      title: "Issue",
      url: "https://github.com/getpaseo/paseo/issues/55",
    };

    expect(
      buildAgentPrompt(
        "  Take a different approach  ",
        [{ data: "image-data", mimeType: "image/png" }],
        [issue, chatHistory],
      ),
    ).toEqual([
      chatHistory,
      { type: "text", text: "Take a different approach" },
      { type: "image", data: "image-data", mimeType: "image/png" },
      issue,
    ]);
  });

  it("renders github_pr attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://github.com/getpaseo/paseo/pull/123",
        body: "PR body",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitHub PR #123: Fix race in worktree setup");
  });

  it("renders GitLab change request attachments with MR numbering", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "gitlab",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://gitlab.com/getpaseo/paseo/-/merge_requests/123",
        body: "MR body",
        projectPath: "getpaseo/paseo",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitLab MR !123: Fix race in worktree setup");
  });

  it.each(["base", "uncommitted", "all"] as const)("renders %s reviews", (mode) => {
    expect(
      renderPromptAttachmentAsText({
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/tmp/repo",
        mode,
        baseRef: "main",
        comments: [
          {
            filePath: "src/index.ts",
            side: "new",
            lineNumber: 42,
            body: "Please guard this nullable value.",
            context: {
              hunkHeader: "@@ -40,3 +40,4 @@",
              targetLine: {
                oldLineNumber: null,
                newLineNumber: 42,
                type: "add",
                content: "const value = maybeNull.name;",
              },
              lines: [
                {
                  oldLineNumber: 41,
                  newLineNumber: 41,
                  type: "context",
                  content: "const before = true;",
                },
                {
                  oldLineNumber: null,
                  newLineNumber: 42,
                  type: "add",
                  content: "const value = maybeNull.name;",
                },
              ],
            },
          },
        ],
      }),
    ).toBe(
      [
        `Paseo review attachment (${mode})`,
        "CWD: /tmp/repo",
        "Base: main",
        "",
        "Comment 1: src/index.ts:new:42",
        "Please guard this nullable value.",
        "@@ -40,3 +40,4 @@",
        "  41 41  const before = true;",
        ">  - 42 +const value = maybeNull.name;",
      ].join("\n"),
    );
  });

  it("renders github_issue attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 55,
        title: "Issue",
        url: "https://github.com/getpaseo/paseo/issues/55",
      }),
    ).toContain("GitHub Issue #55: Issue");
  });

  it("renders text attachments as their client-provided prompt text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "text",
        mimeType: "text/plain",
        title: "Browser element",
        text: "<browser-element>button.primary</browser-element>",
      }),
    ).toBe("<browser-element>button.primary</browser-element>");
  });

  it("renders uploaded file attachments as local file references", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "uploaded_file",
        id: "upload_req-upload",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 11,
        path: "/tmp/paseo/uploads/upload_req-upload/notes.txt",
      }),
    ).toBe(
      [
        "Uploaded file: notes.txt",
        "fileId: upload_req-upload",
        "Path: /tmp/paseo/uploads/upload_req-upload/notes.txt",
        "MIME: text/plain",
        "Size: 11 bytes",
      ].join("\n"),
    );
  });

  describe("storePromptImages", () => {
    const homes: string[] = [];
    const makeHome = () => {
      const home = mkdtempSync(join(tmpdir(), "paseo-prompt-images-"));
      homes.push(home);
      return home;
    };
    afterEach(() => {
      for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    });
    const png = Buffer.from("fake png bytes");
    const image = { data: png.toString("base64"), mimeType: "image/png" };

    it("saves an inline image to the upload store and attaches its path", async () => {
      const home = makeHome();
      const issue = {
        type: "github_issue" as const,
        number: 7,
        title: "Bug",
        url: "https://github.com/o/r/issues/7",
      };

      const attachments = await storePromptImages(home, [image], [issue]);

      expect(attachments).toHaveLength(2);
      expect(attachments?.[0]).toBe(issue);
      const stored = attachments?.[1];
      if (stored?.type !== "uploaded_file") throw new Error("expected an uploaded_file");
      expect(stored).toMatchObject({ fileName: "image-1.png", mimeType: "image/png", size: 14 });
      expect(readFileSync(stored.path)).toEqual(png);
      // Resolvable by id, so the agent can pass it on as attachments: [{fileId}].
      expect(await readStoredUpload(home, stored.id)).toEqual(stored);
    });

    it("does not store an image that already rides as an uploaded file", async () => {
      const home = makeHome();
      const [upload] = (await storePromptImages(home, [image], undefined)) ?? [];
      if (upload?.type !== "uploaded_file") throw new Error("expected an uploaded_file");

      expect(await storePromptImages(home, [image], [upload])).toEqual([upload]);
    });

    it("passes attachments through without a paseo home", async () => {
      expect(await storePromptImages(undefined, [image], undefined)).toBeUndefined();
    });
  });

  it("returns undefined when firstAgentContext is empty", () => {
    expect(buildAgentBranchNameSeed(undefined)).toBeUndefined();
    expect(buildAgentBranchNameSeed({})).toBeUndefined();
    expect(buildAgentBranchNameSeed({ prompt: "   " })).toBeUndefined();
    expect(buildAgentBranchNameSeed({ attachments: [] })).toBeUndefined();
  });

  it("wraps prompt and rendered attachments as tagged naming input", () => {
    expect(
      buildAgentBranchNameSeed({
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Fix worktree naming",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "fix/worktree-naming",
          },
        ],
      }),
    ).toBe(
      "<user-prompt>\nInvestigate flaky test\n</user-prompt>\n\n<attachments>\nGitHub PR #123: Fix worktree naming\nhttps://github.com/getpaseo/paseo/pull/123\nBase: main\nHead: fix/worktree-naming\n</attachments>",
    );
  });
});
