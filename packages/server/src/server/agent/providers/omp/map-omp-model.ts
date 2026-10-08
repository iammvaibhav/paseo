import type {
  AgentModelDefinition,
  AgentProvider,
  AgentSelectOption,
} from "../../agent-sdk-types.js";
import { OmpThinkingLevelSchema, type OmpModel, type OmpThinkingLevel } from "./rpc-types.js";

export const DEFAULT_OMP_THINKING_LEVEL: OmpThinkingLevel = "medium";

export const OMP_THINKING_OPTIONS: ReadonlyArray<{
  id: OmpThinkingLevel;
  label: string;
  description: string;
  isDefault?: boolean;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "auto", label: "Auto", description: "OMP picks the effort each turn" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Extra-high reasoning" },
  { id: "max", label: "Max", description: "Maximum reasoning" },
] as const;

/** Canonical effort order: minimal < low < medium < high < xhigh < max. */
const OMP_EFFORT_ORDER: readonly OmpThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function mapThinkingOption(
  option: (typeof OMP_THINKING_OPTIONS)[number],
  isDefault?: boolean,
): AgentSelectOption {
  const mapped: AgentSelectOption = {
    id: option.id,
    label: option.label,
    description: option.description,
  };
  if (isDefault ?? option.isDefault) {
    mapped.isDefault = true;
  }
  return mapped;
}

export function mapOmpModel(
  model: OmpModel,
  provider: AgentProvider,
  settingsDefault: OmpThinkingLevel,
): AgentModelDefinition {
  const { thinkingOptions, defaultThinkingOptionId } = resolveOmpThinkingConfig(
    model,
    settingsDefault,
  );
  return {
    provider,
    id: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.name ?? model.id}`,
    description: `${model.provider}/${model.id}`,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    thinkingOptions,
    defaultThinkingOptionId,
  };
}

function resolveOmpThinkingConfig(
  model: OmpModel,
  settingsDefault: OmpThinkingLevel,
): {
  thinkingOptions: AgentSelectOption[] | undefined;
  defaultThinkingOptionId: string | undefined;
} {
  if (!model.reasoning) {
    return { thinkingOptions: undefined, defaultThinkingOptionId: undefined };
  }
  const efforts = model.thinking?.efforts;
  const recognized = OMP_THINKING_OPTIONS.filter(
    (option) => option.id !== "auto" && option.id !== "off" && efforts?.includes(option.id),
  );
  if (!efforts || efforts.length === 0 || recognized.length === 0) {
    // Older omp versions don't report per-model thinking config, or all reported
    // efforts are unrecognized; expose the full set.
    const defaultThinkingOptionId = clampThinkingDefault(
      requestedThinkingDefault(model, settingsDefault),
      OMP_THINKING_OPTIONS.filter((option) => option.id !== "auto" && option.id !== "off"),
    );
    return {
      thinkingOptions: OMP_THINKING_OPTIONS.map((option) =>
        mapThinkingOption(option, option.id === defaultThinkingOptionId),
      ),
      defaultThinkingOptionId,
    };
  }
  // `auto` and `off` are session-level OMP modes, never per-model efforts, so
  // models do not list them; every reasoning model offers both plus its efforts.
  const options = [OMP_THINKING_OPTIONS[0]!, OMP_THINKING_OPTIONS[1]!, ...recognized];
  const defaultThinkingOptionId = clampThinkingDefault(
    requestedThinkingDefault(model, settingsDefault),
    recognized,
  );
  return {
    thinkingOptions: options.map((option) =>
      mapThinkingOption(option, option.id === defaultThinkingOptionId),
    ),
    defaultThinkingOptionId,
  };
}

function requestedThinkingDefault(
  model: OmpModel,
  settingsDefault: OmpThinkingLevel,
): OmpThinkingLevel {
  const parsed = OmpThinkingLevelSchema.safeParse(model.thinking?.defaultLevel);
  return parsed.success ? parsed.data : settingsDefault;
}

function clampThinkingDefault(
  requested: OmpThinkingLevel,
  offeredEfforts: ReadonlyArray<(typeof OMP_THINKING_OPTIONS)[number]>,
): OmpThinkingLevel {
  if (requested === "auto" || requested === "off") {
    return requested;
  }
  const offered: Record<string, true> = {};
  for (const option of offeredEfforts) {
    offered[option.id] = true;
  }
  const start = OMP_EFFORT_ORDER.indexOf(requested);
  for (let i = start; i >= 0; i--) {
    const candidate = OMP_EFFORT_ORDER[i]!;
    if (offered[candidate]) {
      return candidate;
    }
  }
  return offeredEfforts[0]!.id;
}
