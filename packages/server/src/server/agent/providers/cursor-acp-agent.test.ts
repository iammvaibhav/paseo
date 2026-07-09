import { describe, expect, test, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import {
  ACPAgentSession,
  buildACPClientCapabilities,
  type SpawnedACPProcess,
  type SessionStateResponse,
} from "./acp-agent.js";
import {
  CURSOR_CONTEXT_FEATURE_OPTION,
  CURSOR_FAST_FEATURE_OPTION,
  CursorACPAgentClient,
  normalizeCursorACPConfig,
} from "./cursor-acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

describe("CursorACPAgentClient model discovery", () => {
  interface ClientCapabilityInternals {
    clientCapabilityMeta?: Record<string, unknown>;
  }

  interface FeatureOverrideInternals {
    sessionId: string | null;
    connection: {
      setSessionConfigOption: ReturnType<typeof vi.fn>;
    };
    configOptions: SessionConfigOption[];
    applyConfiguredOverrides(): Promise<void>;
  }

  function fastConfigOption(currentValue: "false" | "true") {
    return {
      id: "fast",
      name: "Fast",
      type: "select" as const,
      currentValue,
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ],
    };
  }

  function contextConfigOption(currentValue: "200k" | "272k") {
    return {
      id: "context",
      name: "Context",
      type: "select" as const,
      currentValue,
      options: [
        { value: "200k", name: "200k" },
        { value: "272k", name: "272k" },
      ],
    };
  }

  function createCursorSessionWithFeatureValues(
    featureValues: Record<string, unknown>,
  ): ACPAgentSession {
    return new ACPAgentSession(
      {
        provider: "acp",
        cwd: "/tmp/cursor",
        featureValues,
      },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["cursor-agent", "acp"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
        configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION, CURSOR_CONTEXT_FEATURE_OPTION],
      },
    );
  }

  class TestCursorACPAgentClient extends CursorACPAgentClient {
    constructor(
      response: SessionStateResponse,
      options: {
        setSessionConfigOption?: ReturnType<typeof vi.fn>;
      } = {},
    ) {
      super({
        logger: createTestLogger(),
        command: ["cursor-agent", "acp"],
      });
      this.response = response;
      this.setSessionConfigOption = options.setSessionConfigOption ?? vi.fn();
    }

    private readonly response: SessionStateResponse;
    readonly setSessionConfigOption: ReturnType<typeof vi.fn>;

    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(this.response),
          setSessionConfigOption: this.setSessionConfigOption,
        },
        initialize: { agentCapabilities: {} },
      } as SpawnedACPProcess;
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("advertises Cursor parameterized model picker metadata", () => {
    const client = new CursorACPAgentClient({
      logger: createTestLogger(),
      command: ["cursor-agent", "acp"],
    });

    const capabilities = buildACPClientCapabilities(
      asInternals<ClientCapabilityInternals>(client).clientCapabilityMeta,
    );

    expect(capabilities).toEqual({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
      _meta: {
        parameterizedModelPicker: true,
      },
    });
  });

  test("does not advertise Cursor parameterized model picker metadata for generic ACP", () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["test-acp"],
    });

    const capabilities = buildACPClientCapabilities(
      asInternals<ClientCapabilityInternals>(client).clientCapabilityMeta,
    );

    expect(capabilities).toEqual({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    });
  });

  test("normalizes legacy parameterized Cursor model ids", () => {
    expect(
      normalizeCursorACPConfig({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      }),
    ).toEqual({
      provider: "acp",
      cwd: "/tmp/cursor",
      model: "gpt-5.4",
      thinkingOptionId: "medium",
      featureValues: {
        context: "272k",
        fast: "false",
      },
    });
  });

  test("normalizes legacy parameterized Cursor model ids without overriding explicit values", () => {
    expect(
      normalizeCursorACPConfig({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "gpt-5.4[reasoning=medium,fast=false]",
        thinkingOptionId: "high",
        featureValues: {
          fast: "true",
        },
      }),
    ).toEqual({
      provider: "acp",
      cwd: "/tmp/cursor",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      featureValues: {
        fast: "true",
      },
    });
  });

  test("defaults explicit Cursor base model selections to non-fast", () => {
    expect(
      normalizeCursorACPConfig({
        provider: "acp",
        cwd: "/tmp/cursor",
        model: "composer-2.5",
      }),
    ).toEqual({
      provider: "acp",
      cwd: "/tmp/cursor",
      model: "composer-2.5",
      featureValues: {
        fast: "false",
      },
    });
  });

  test("returns only ACP model ids because Cursor CLI ids cannot select ACP models", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: {
        currentModelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        availableModels: [
          {
            modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
            name: "gpt-5.4",
            description: null,
          },
        ],
      },
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
          label: "gpt-5.4",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("does not fall back to cursor-agent models when ACP reports zero models", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [],
      modes: [],
    });
  });

  test("keeps parameterized Cursor models as plain ACP ids", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: {
        currentModelId: "composer-2.5",
        availableModels: [
          {
            modelId: "composer-2.5",
            name: "Composer 2.5",
            description: null,
          },
        ],
      },
      configOptions: [fastConfigOption("false")],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/cursor", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "acp",
          id: "composer-2.5",
          label: "Composer 2.5",
          description: undefined,
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });

  test("exposes Cursor fast mode as a provider feature", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [fastConfigOption("false")],
    });

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
      }),
    ).resolves.toEqual([
      {
        type: "select",
        id: CURSOR_FAST_FEATURE_OPTION.id,
        label: "Fast",
        description: "Cursor fast mode",
        tooltip: "Select Cursor fast mode",
        icon: "zap",
        value: "false",
        options: [
          {
            id: "false",
            label: "Off",
            isDefault: true,
            description: undefined,
            metadata: undefined,
          },
          {
            id: "true",
            label: "Fast",
            isDefault: false,
            description: undefined,
            metadata: undefined,
          },
        ],
      },
    ]);
  });

  test("exposes Cursor context as a provider feature", async () => {
    const client = new TestCursorACPAgentClient({
      sessionId: "session-1",
      models: null,
      configOptions: [contextConfigOption("272k")],
    });

    await expect(
      client.listFeatures({
        provider: "acp",
        cwd: "/tmp/cursor",
      }),
    ).resolves.toEqual([
      {
        type: "select",
        id: CURSOR_CONTEXT_FEATURE_OPTION.id,
        label: "Context",
        description: "Cursor context window",
        tooltip: "Select Cursor context window",
        icon: undefined,
        value: "272k",
        options: [
          {
            id: "200k",
            label: "200k",
            isDefault: false,
            description: undefined,
            metadata: undefined,
          },
          {
            id: "272k",
            label: "272k",
            isDefault: true,
            description: undefined,
            metadata: undefined,
          },
        ],
      },
    ]);
  });

  test("applies Cursor non-fast configured feature value", async () => {
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [fastConfigOption("false")],
    });
    const session = createCursorSessionWithFeatureValues({ fast: "false" });
    const internals = asInternals<FeatureOverrideInternals>(session);
    internals.sessionId = "session-1";
    internals.connection = { setSessionConfigOption };
    internals.configOptions = [fastConfigOption("true")];

    await internals.applyConfiguredOverrides();

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "fast",
      value: "false",
    });
  });

  test("applies Cursor context configured feature value", async () => {
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [contextConfigOption("272k")],
    });
    const session = createCursorSessionWithFeatureValues({ context: "272k" });
    const internals = asInternals<FeatureOverrideInternals>(session);
    internals.sessionId = "session-1";
    internals.connection = { setSessionConfigOption };
    internals.configOptions = [contextConfigOption("200k")];

    await internals.applyConfiguredOverrides();

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "context",
      value: "272k",
    });
  });

  test("skips Cursor configured feature values omitted by the ACP runtime", async () => {
    const setSessionConfigOption = vi.fn();
    const session = createCursorSessionWithFeatureValues({ fast: "false" });
    const internals = asInternals<FeatureOverrideInternals>(session);
    internals.sessionId = "session-1";
    internals.connection = { setSessionConfigOption };
    internals.configOptions = [];

    await expect(internals.applyConfiguredOverrides()).resolves.toBeUndefined();

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });
});
