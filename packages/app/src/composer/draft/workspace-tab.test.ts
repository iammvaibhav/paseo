import { describe, expect, test } from "vitest";

import { shouldAllowEmptyDraftText, validateDraftSubmission } from "./workspace-tab-core";

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
