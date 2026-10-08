import { describe, expect, test } from "vitest";

import { mapOmpModel } from "./map-omp-model.js";
import type { OmpModel, OmpThinkingLevel } from "./rpc-types.js";

function baseModel(overrides: Partial<OmpModel> = {}): OmpModel {
  return {
    provider: "pioneer",
    id: "canada-quant/glm-5.2",
    name: "GLM-5.2",
    ...overrides,
  };
}

const FULL_SET = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];

function effortModel(
  efforts: string[],
  defaultLevel?: string,
  settingsDefault: OmpThinkingLevel = "high",
) {
  return {
    model: baseModel({
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts,
        ...(defaultLevel === undefined ? {} : { defaultLevel }),
      },
    }),
    settingsDefault,
  };
}

describe("mapOmpModel thinking options", () => {
  test("limits thinking options to the model's reported efforts", () => {
    const model = baseModel({
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts: ["high", "xhigh"],
        defaultLevel: "xhigh",
        effortMap: { high: "high", xhigh: "max" },
      },
    });

    const result = mapOmpModel(model, "omp", "high");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "auto",
      "high",
      "xhigh",
    ]);
    expect(result.defaultThinkingOptionId).toBe("xhigh");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("xhigh");
  });

  test("orders off, auto, then the model's efforts, as omp cycles them", () => {
    const { model, settingsDefault } = effortModel(["low", "high"], "high");

    const result = mapOmpModel(model, "omp", settingsDefault);

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "auto",
      "low",
      "high",
    ]);
  });

  test("model defaultLevel wins over the settings default", () => {
    const { model } = effortModel(["low", "medium", "high"], "low", "high");

    const result = mapOmpModel(model, "omp", "high");

    expect(result.defaultThinkingOptionId).toBe("low");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("low");
  });

  test("clamps a model default above the offered efforts down", () => {
    const { model } = effortModel(["low", "high"], "xhigh", "low");

    const result = mapOmpModel(model, "omp", "low");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "auto",
      "low",
      "high",
    ]);
    expect(result.defaultThinkingOptionId).toBe("high");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("high");
  });

  test("uses the settings default when the model reports none", () => {
    const { model } = effortModel(["low", "high"], undefined, "auto");

    const result = mapOmpModel(model, "omp", "auto");

    expect(result.defaultThinkingOptionId).toBe("auto");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("auto");
  });

  test("clamps the settings default down to the highest offered effort", () => {
    const { model } = effortModel(["low", "medium"], undefined, "high");

    const result = mapOmpModel(model, "omp", "high");

    expect(result.defaultThinkingOptionId).toBe("medium");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("medium");
  });

  test("clamps the settings default up to the lowest offered effort", () => {
    const { model } = effortModel(["low", "high"], undefined, "minimal");

    const result = mapOmpModel(model, "omp", "minimal");

    expect(result.defaultThinkingOptionId).toBe("low");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("low");
  });

  test("keeps a settings default of off", () => {
    const { model } = effortModel(["low", "high"], undefined, "off");

    const result = mapOmpModel(model, "omp", "off");

    expect(result.defaultThinkingOptionId).toBe("off");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("off");
  });

  test("exposes the full set when reasoning is true but no thinking config is reported", () => {
    const model = baseModel({ reasoning: true });

    const result = mapOmpModel(model, "omp", "high");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(FULL_SET);
    expect(result.defaultThinkingOptionId).toBe("high");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("high");
  });

  test("exposes the full set when efforts is empty", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: [] },
    });

    const result = mapOmpModel(model, "omp", "high");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(FULL_SET);
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("omits thinking options entirely when reasoning is false", () => {
    const model = baseModel({ reasoning: false });

    const result = mapOmpModel(model, "omp", "high");

    expect(result.thinkingOptions).toBeUndefined();
    expect(result.defaultThinkingOptionId).toBeUndefined();
  });

  test("omits thinking options when reasoning is absent", () => {
    const model = baseModel({});

    const result = mapOmpModel(model, "omp", "high");

    expect(result.thinkingOptions).toBeUndefined();
    expect(result.defaultThinkingOptionId).toBeUndefined();
  });

  test("falls back to the full set when every reported effort is unknown", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["ultra", "turbo"], defaultLevel: "turbo" },
    });

    const result = mapOmpModel(model, "omp", "high");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(FULL_SET);
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("offers auto without making it the default when the model has one", () => {
    const { model, settingsDefault } = effortModel(["low", "high"], "high");

    const result = mapOmpModel(model, "omp", settingsDefault);

    expect(result.thinkingOptions?.map((option) => option.id)).toContain("auto");
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("preserves provider and model id in the mapped definition", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["high", "xhigh"], defaultLevel: "xhigh" },
    });

    const result = mapOmpModel(model, "omp", "high");

    expect(result.provider).toBe("omp");
    expect(result.id).toBe("pioneer/canada-quant/glm-5.2");
    expect(result.label).toBe("pioneer/GLM-5.2");
    expect(result.metadata).toEqual({ provider: "pioneer", modelId: "canada-quant/glm-5.2" });
  });
});
