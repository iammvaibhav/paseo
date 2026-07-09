import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

const THINKING_PARAMETER_IDS = new Set(["reasoning", "thought_level"]);

export interface ParameterizedModelId {
  baseModelId: string;
  parameters: Record<string, string>;
}

export function parseParameterizedModelId(
  modelId: string | null | undefined,
): ParameterizedModelId | null {
  const normalizedModelId = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalizedModelId) {
    return null;
  }

  const match = /^(.+)\[([^\]]+)\]$/.exec(normalizedModelId);
  if (!match) {
    return null;
  }

  const baseModelId = match[1]?.trim();
  const rawParameters = match[2];
  if (!baseModelId || !rawParameters) {
    return null;
  }

  const parameters: Record<string, string> = {};
  for (const rawParameter of rawParameters.split(",")) {
    const [rawKey, ...rawValueParts] = rawParameter.split("=");
    const key = rawKey?.trim();
    const value = rawValueParts.join("=").trim();
    if (!key || rawValueParts.length === 0) {
      continue;
    }
    parameters[key] = value;
  }

  if (Object.keys(parameters).length === 0) {
    return null;
  }

  return { baseModelId, parameters };
}

export function resolveParameterizedModelThinkingOptionId(
  modelId: string | null | undefined,
): string {
  const parsed = parseParameterizedModelId(modelId);
  if (!parsed) {
    return "";
  }
  return parsed.parameters.reasoning ?? parsed.parameters.thought_level ?? "";
}

export function resolveParameterizedModelFeatureValues(
  modelId: string | null | undefined,
): Record<string, string> {
  const parsed = parseParameterizedModelId(modelId);
  if (!parsed) {
    return {};
  }

  const featureValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.parameters)) {
    if (THINKING_PARAMETER_IDS.has(key)) {
      continue;
    }
    featureValues[key] = value;
  }
  return featureValues;
}

export function resolveModelDefinitionById(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) {
    return null;
  }

  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return null;
  }

  const exactModel = availableModels.find((model) => model.id === normalizedModelId);
  if (exactModel) {
    return exactModel;
  }

  const parameterizedModel = parseParameterizedModelId(normalizedModelId);
  if (!parameterizedModel) {
    return null;
  }
  return availableModels.find((model) => model.id === parameterizedModel.baseModelId) ?? null;
}

export function isSelectableModelId(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): boolean {
  return Boolean(resolveModelDefinitionById(availableModels, modelId));
}
