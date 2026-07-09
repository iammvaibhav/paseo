import type { Logger } from "pino";

import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { ACPConfigFeatureOption } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

interface CursorParameterizedModel {
  model: string;
  featureValues: Record<string, string>;
  thinkingOptionId?: string;
}

export class CursorACPAgentClient extends GenericACPAgentClient {
  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
    });
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return super.createSession(normalizeCursorACPConfig(config), launchContext);
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return super.resumeSession(
      normalizeCursorPersistenceHandle(handle),
      overrides ? normalizeCursorACPConfig(overrides) : undefined,
      launchContext,
    );
  }
}

export function normalizeCursorACPConfig<T extends Partial<AgentSessionConfig>>(config: T): T {
  const parsed = parseCursorParameterizedModel(config.model);
  if (!parsed && !config.model) {
    return config;
  }
  const featureValues = {
    ...parsed?.featureValues,
    ...config.featureValues,
  };
  if (!Object.prototype.hasOwnProperty.call(featureValues, CURSOR_FAST_FEATURE_OPTION.id)) {
    featureValues[CURSOR_FAST_FEATURE_OPTION.id] = "false";
  }

  return {
    ...config,
    ...(parsed ? { model: parsed.model } : {}),
    ...(parsed?.thinkingOptionId && !config.thinkingOptionId
      ? { thinkingOptionId: parsed.thinkingOptionId }
      : {}),
    ...(Object.keys(featureValues).length > 0 ? { featureValues } : {}),
  };
}

function normalizeCursorPersistenceHandle(handle: AgentPersistenceHandle): AgentPersistenceHandle {
  if (!handle.metadata) {
    return handle;
  }
  return {
    ...handle,
    metadata: normalizeCursorACPConfig(handle.metadata as Partial<AgentSessionConfig>),
  };
}

function parseCursorParameterizedModel(model: string | undefined): CursorParameterizedModel | null {
  if (!model) {
    return null;
  }

  const match = /^(.+)\[([^\]]+)\]$/.exec(model);
  if (!match) {
    return null;
  }

  const [, baseModel, rawParameters] = match;
  if (!baseModel) {
    return null;
  }

  const featureValues: Record<string, string> = {};
  let thinkingOptionId: string | undefined;
  for (const rawParameter of rawParameters.split(",")) {
    const [rawKey, ...rawValueParts] = rawParameter.split("=");
    const key = rawKey?.trim();
    const value = rawValueParts.join("=").trim();
    if (!key || rawValueParts.length === 0) {
      continue;
    }
    if (key === "reasoning" || key === "thought_level") {
      thinkingOptionId = value;
      continue;
    }
    featureValues[key] = value;
  }

  return {
    model: baseModel,
    featureValues,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}
