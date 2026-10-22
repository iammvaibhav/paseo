import { describe, expect, test } from "vitest";

import {
  shouldAllowEmptyDraftText,
  submitDraftCreateRequest,
  validateDraftSubmission,
  type WorkspaceDraftSubmitClient,
} from "./workspace-tab-core";
import type { WorkspaceDraftForkSource } from "@/workspace-tabs/model";

const baseComposerState = {
  providerDefinitions: [{ id: "codewhale" }],
  selectedProvider: "codewhale",
  isModelLoading: false,
  effectiveModelId: "",
  availableModels: [],
};

function validate(overrides = {}) {
  return validateDraftSubmission({
    text: "hello",
    allowsEmptyAutoSubmit: false,
    composerState: baseComposerState,
    autoSubmitConfig: null,
    workspaceDirectory: "/tmp/project",
    hasClient: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("allows a ready provider with no models to submit without a selected model", () => {
    expect(validate({})).toBeNull();
  });

  test("keeps waiting while model defaults are loading", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          isModelLoading: true,
        },
      }),
    ).toBe("Model defaults are still loading");
  });

  test("still requires a selected model when the provider exposes models", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          availableModels: [{ id: "deepseek/deepseek-v4-pro" }],
        },
      }),
    ).toBe("No model is available for the selected provider");
  });
});

describe("workspace draft empty text readiness", () => {
  test("allows attachment-only retries after a fork draft create fails", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [{ kind: "chat_history" }],
      }),
    ).toBe(true);
  });

  test("still rejects empty drafts with no auto-submit and no attachments", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [],
      }),
    ).toBe(false);
  });

  test("allows empty drafts when voice mode starts an agent from a new tab", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: true,
        attachments: [],
      }),
    ).toBe(true);
  });

  test("validateDraftSubmission accepts empty text when empty auto-submit is allowed", () => {
    expect(
      validate({
        text: "",
        allowsEmptyAutoSubmit: true,
      }),
    ).toBeNull();
  });

  test("validateDraftSubmission still rejects empty text without empty auto-submit", () => {
    expect(
      validate({
        text: "",
        allowsEmptyAutoSubmit: false,
      }),
    ).toBe("Initial prompt is required");
  });
});

interface RecordedForkCall {
  sourceAgentId: string;
  text: string;
  options: Record<string, unknown>;
}

function createSubmitClient(options: { forkAgentSnapshot?: { id: string } | null } = {}) {
  const forkAgentSnapshot =
    options.forkAgentSnapshot === undefined ? { id: "agent-forked" } : options.forkAgentSnapshot;
  const createAgentCalls: Record<string, unknown>[] = [];
  const forkAgentCalls: RecordedForkCall[] = [];
  const client = {
    createAgent: async (request: Record<string, unknown>) => {
      createAgentCalls.push(request);
      return { id: "agent-created" };
    },
    forkAgent: async (
      sourceAgentId: string,
      text: string,
      forkOptions: Record<string, unknown>,
    ) => {
      forkAgentCalls.push({ sourceAgentId, text, options: forkOptions });
      return {
        agentId: "agent-forked",
        agent: forkAgentSnapshot,
      };
    },
  } as unknown as WorkspaceDraftSubmitClient;
  return { client, createAgentCalls, forkAgentCalls };
}

const forkSource: WorkspaceDraftForkSource = {
  sourceAgentId: "agent-src",
  boundaryCursor: { epoch: "epoch-1", seq: 7 },
  boundaryMessageId: "assistant-msg-1",
};

function submit(
  client: WorkspaceDraftSubmitClient,
  overrides: Partial<Parameters<typeof submitDraftCreateRequest>[0]> = {},
) {
  return submitDraftCreateRequest({
    attempt: { clientMessageId: "client-msg-1" },
    text: "keep going",
    cwd: "/tmp/project",
    client,
    workspaceDirectory: "/tmp/project",
    workspaceId: "ws-1",
    autoSubmitConfig: null,
    composerState: {
      selectedProvider: "codewhale",
      selectedMode: "build",
      modeOptions: [{ id: "build" }],
      effectiveModelId: "deepseek/deepseek-v4-pro",
      effectiveThinkingOptionId: "high",
      featureValues: { webSearch: true },
    },
    hostDisconnectedMessage: "Host disconnected",
    selectModelMessage: "Select a model",
    forkFailedMessage: "Failed to fork chat",
    ...overrides,
  });
}

describe("workspace draft fork submission", () => {
  test("forks the source agent instead of creating a plain agent", async () => {
    const { client, createAgentCalls, forkAgentCalls } = createSubmitClient();

    const result = await submit(client, { forkSource });

    expect(createAgentCalls).toEqual([]);
    expect(result).toEqual({ agentId: "agent-forked", result: { id: "agent-forked" } });
    expect(forkAgentCalls).toHaveLength(1);
    expect(forkAgentCalls[0].sourceAgentId).toBe("agent-src");
    expect(forkAgentCalls[0].text).toBe("keep going");
  });

  test("sends the fork boundary pair and the composer's config overrides", async () => {
    const { client, forkAgentCalls } = createSubmitClient();

    await submit(client, { forkSource });

    expect(forkAgentCalls[0].options).toEqual({
      messageId: "client-msg-1",
      boundaryCursor: { epoch: "epoch-1", seq: 7 },
      boundaryMessageId: "assistant-msg-1",
      overrides: {
        provider: "codewhale",
        modeId: "build",
        model: "deepseek/deepseek-v4-pro",
        thinkingOptionId: "high",
        featureValues: { webSearch: true },
      },
    });
  });

  test("omits boundary keys the draft never captured", async () => {
    const { client, forkAgentCalls } = createSubmitClient();

    await submit(client, { forkSource: { sourceAgentId: "agent-src" } });

    expect(forkAgentCalls[0].options).not.toHaveProperty("boundaryCursor");
    expect(forkAgentCalls[0].options).not.toHaveProperty("boundaryMessageId");
  });

  test("carries the fork composer's provider so a fork can switch providers", async () => {
    const { client, forkAgentCalls } = createSubmitClient();

    await submit(client, { forkSource });

    const overrides = forkAgentCalls[0].options.overrides as Record<string, unknown>;
    expect(overrides.provider).toBe("codewhale");
    // cwd stays the source's; the fork runs in the same workspace directory.
    expect(overrides).not.toHaveProperty("cwd");
  });

  test("strips the chat-history preview from the fork payload so the daemon's transcript is not duplicated", async () => {
    const { client, forkAgentCalls } = createSubmitClient();

    await submit(client, {
      forkSource,
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          title: "Chat history",
          text: "Previous conversation",
        },
        { type: "text", mimeType: "text/plain", title: "A note", text: "keep this" },
      ],
    });

    const options = forkAgentCalls[0].options;
    expect(options.attachments).toEqual([
      { type: "text", mimeType: "text/plain", title: "A note", text: "keep this" },
    ]);
  });

  test("fails loudly instead of creating a plain agent when the fork has no snapshot", async () => {
    const { client, createAgentCalls } = createSubmitClient({ forkAgentSnapshot: null });

    await expect(submit(client, { forkSource })).rejects.toThrow("Failed to fork chat");
    expect(createAgentCalls).toEqual([]);
  });

  test("still creates a plain agent when the draft is not a fork", async () => {
    const { client, createAgentCalls, forkAgentCalls } = createSubmitClient();

    const result = await submit(client);

    expect(forkAgentCalls).toEqual([]);
    expect(result).toEqual({ agentId: "agent-created", result: { id: "agent-created" } });
    expect(createAgentCalls[0]).toMatchObject({
      workspaceId: "ws-1",
      initialPrompt: "keep going",
      clientMessageId: "client-msg-1",
      config: {
        provider: "codewhale",
        cwd: "/tmp/project",
        modeId: "build",
        model: "deepseek/deepseek-v4-pro",
        thinkingOptionId: "high",
        featureValues: { webSearch: true },
      },
    });
  });
});
