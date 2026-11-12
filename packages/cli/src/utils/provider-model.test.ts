import { describe, expect, test } from "vitest";

import { resolveProviderAndModel } from "./provider-model.js";

describe("resolveProviderAndModel", () => {
  test("requires an explicit provider when no default is supplied", () => {
    expect(() => resolveProviderAndModel({})).toThrow(
      expect.objectContaining({
        code: "MISSING_PROVIDER",
        message: "Provider is required",
      }),
    );
  });

  test("uses an explicit default provider when supplied by a scoped caller", () => {
    expect(resolveProviderAndModel({ defaultProvider: "claude" })).toEqual({
      provider: "claude",
      model: undefined,
    });
  });

  test("parses provider/model shorthand", () => {
    expect(resolveProviderAndModel({ provider: "codex/gpt-5.4" })).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  test("accepts the provider:model form config and the app use", () => {
    expect(resolveProviderAndModel({ provider: "omp:anthropic/claude-opus-5-5" })).toEqual({
      provider: "omp",
      model: "anthropic/claude-opus-5-5",
    });
  });

  test("rejects conflicting model values", () => {
    expect(() =>
      resolveProviderAndModel({ provider: "codex/gpt-5.4", model: "gpt-5.4-mini" }),
    ).toThrow(
      expect.objectContaining({
        code: "CONFLICTING_MODEL_OPTIONS",
      }),
    );
  });
});
