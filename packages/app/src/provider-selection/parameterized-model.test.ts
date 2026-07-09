import { describe, expect, it } from "vitest";

import {
  parseParameterizedModelId,
  resolveModelDefinitionById,
  resolveParameterizedModelFeatureValues,
  resolveParameterizedModelThinkingOptionId,
} from "./parameterized-model";

describe("parameterized model ids", () => {
  it("parses base model ids and keyed parameters", () => {
    expect(parseParameterizedModelId("gpt-5.4[reasoning=medium,fast=true]")).toEqual({
      baseModelId: "gpt-5.4",
      parameters: {
        reasoning: "medium",
        fast: "true",
      },
    });
  });

  it("separates thinking parameters from feature values", () => {
    const modelId = "gpt-5.4[context=272k,reasoning=medium,fast=false]";

    expect(resolveParameterizedModelThinkingOptionId(modelId)).toBe("medium");
    expect(resolveParameterizedModelFeatureValues(modelId)).toEqual({
      context: "272k",
      fast: "false",
    });
  });

  it("matches parameterized ids to their base catalog model", () => {
    expect(
      resolveModelDefinitionById(
        [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
        "gpt-5.4[fast=true]",
      ),
    ).toEqual({ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" });
  });
});
