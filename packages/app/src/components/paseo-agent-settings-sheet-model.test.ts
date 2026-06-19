import { describe, expect, it } from "vitest";

import {
  createOpenRouterProviderInput,
  parsePaseoAgentModelIds,
  paseoAgentAuthLabel,
} from "./paseo-agent-settings-sheet-model";

describe("paseo-agent-settings-sheet-model", () => {
  it("parses model ids from comma and newline separated input", () => {
    expect(
      parsePaseoAgentModelIds(`
        anthropic/claude-3.7-sonnet, openai/gpt-4o
        anthropic/claude-3.7-sonnet
        openai/gpt-4o-mini
      `),
    ).toEqual(["anthropic/claude-3.7-sonnet", "openai/gpt-4o", "openai/gpt-4o-mini"]);
  });

  it("builds the OpenRouter provider payload without an empty api key", () => {
    expect(
      createOpenRouterProviderInput({
        name: " openrouter-main ",
        apiKey: "  ",
        modelIds: ["openai/gpt-4o-mini"],
      }),
    ).toEqual({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        models: [{ id: "openai/gpt-4o-mini" }],
      },
    });
  });

  it("builds the OpenRouter provider payload with a trimmed api key", () => {
    expect(
      createOpenRouterProviderInput({
        name: "openrouter-main",
        apiKey: " sk-or-secret ",
        modelIds: ["openai/gpt-4o-mini", "anthropic/claude-3.7-sonnet"],
      }),
    ).toEqual({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-or-secret",
        models: [{ id: "openai/gpt-4o-mini" }, { id: "anthropic/claude-3.7-sonnet" }],
      },
    });
  });

  it("describes the provider auth state", () => {
    expect(paseoAgentAuthLabel({ kind: "api_key", configured: true })).toBe("API key configured");
    expect(paseoAgentAuthLabel({ kind: "api_key", configured: false })).toBe("API key required");
    expect(paseoAgentAuthLabel({ kind: "oauth", configured: true })).toBe("ChatGPT login stored");
    expect(paseoAgentAuthLabel({ kind: "oauth", configured: false })).toBe("Login required");
    expect(paseoAgentAuthLabel({ kind: "none", configured: false })).toBe("No auth");
  });
});
