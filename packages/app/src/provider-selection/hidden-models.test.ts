import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { buildHiddenModelKey, useHiddenModelsStore } from "./hidden-models";
import {
  buildSelectableProviderSelectorProviders,
  filterHiddenProviderModelRows,
  getAllProviderModelRows,
  resolveSelectedModelLabel,
} from "./provider-selection";

const OMP_ENTRY: ProviderSnapshotEntry = {
  provider: "omp",
  status: "ready",
  enabled: true,
  label: "Oh My Pi",
  models: [
    { provider: "omp", id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
    { provider: "omp", id: "cursor/claude-opus-5", label: "cursor/claude-opus-5" },
    { provider: "omp", id: "cursor/gemini-3.6-flash", label: "cursor/gemini-3.6-flash" },
  ],
};

function catalog() {
  return buildSelectableProviderSelectorProviders([OMP_ENTRY]);
}

function hide(...keys: string[]): ReadonlySet<string> {
  return new Set(keys);
}

beforeEach(() => {
  useHiddenModelsStore.setState({ hiddenKeys: new Set<string>() });
});

describe("hidden models store", () => {
  it("hides and unhides a single model", () => {
    const { setModelHidden } = useHiddenModelsStore.getState();

    setModelHidden("omp", "cursor/claude-opus-5", true);
    expect([...useHiddenModelsStore.getState().hiddenKeys]).toEqual(["omp:cursor/claude-opus-5"]);

    setModelHidden("omp", "cursor/claude-opus-5", false);
    expect([...useHiddenModelsStore.getState().hiddenKeys]).toEqual([]);
  });

  it("hides and unhides a whole list in one write", () => {
    const models = OMP_ENTRY.models?.map((model) => ({ provider: "omp", modelId: model.id })) ?? [];

    useHiddenModelsStore.getState().setModelsHidden(models, true);
    expect(useHiddenModelsStore.getState().hiddenKeys.size).toBe(3);

    useHiddenModelsStore.getState().setModelsHidden(models, false);
    expect(useHiddenModelsStore.getState().hiddenKeys.size).toBe(0);
  });

  it("keeps the same set reference when a toggle changes nothing", () => {
    const before = useHiddenModelsStore.getState().hiddenKeys;

    useHiddenModelsStore.getState().setModelHidden("omp", "cursor/claude-opus-5", false);

    // Pickers memoize on this reference; a no-op toggle must not invalidate them.
    expect(useHiddenModelsStore.getState().hiddenKeys).toBe(before);
  });

  it("keys a model by provider and id", () => {
    expect(buildHiddenModelKey("omp", "cursor/claude-opus-5")).toBe("omp:cursor/claude-opus-5");
  });
});

describe("filterHiddenProviderModelRows", () => {
  it("drops hidden rows from the choosable list", () => {
    const filtered = filterHiddenProviderModelRows({
      providers: catalog(),
      hiddenKeys: hide("omp:cursor/claude-opus-5", "omp:cursor/gemini-3.6-flash"),
    });

    expect(getAllProviderModelRows(filtered).map((row) => row.modelId)).toEqual([
      "anthropic/claude-opus-5",
    ]);
  });

  it("returns the same array when nothing is hidden", () => {
    const providers = catalog();

    expect(filterHiddenProviderModelRows({ providers, hiddenKeys: hide() })).toBe(providers);
  });

  it("keeps the active pick listed even when it is hidden", () => {
    const filtered = filterHiddenProviderModelRows({
      providers: catalog(),
      hiddenKeys: hide("omp:cursor/claude-opus-5"),
      selectedProvider: "omp",
      selectedModel: "cursor/claude-opus-5",
    });

    expect(getAllProviderModelRows(filtered).map((row) => row.modelId)).toContain(
      "cursor/claude-opus-5",
    );
  });

  it("leaves loading and error providers untouched", () => {
    const providers = buildSelectableProviderSelectorProviders([
      { provider: "claude", status: "loading", enabled: true, models: [] },
      { provider: "codex", status: "error", enabled: true, error: "boom", models: [] },
    ]);

    const filtered = filterHiddenProviderModelRows({
      providers,
      hiddenKeys: hide("claude:anything"),
    });

    expect(filtered.map((provider) => provider.modelSelection.kind)).toEqual(["loading", "error"]);
  });
});

describe("hidden models never break the selected label", () => {
  it("names a hidden model the provider fell back onto", () => {
    // omp falls back from anthropic/claude-opus-5 to cursor/claude-opus-5. The
    // user hid the fallback, so it is not offered — but the composer must still
    // say which model actually ran.
    const catalogProviders = catalog();
    const hiddenKeys = hide("omp:cursor/claude-opus-5");
    const visible = filterHiddenProviderModelRows({ providers: catalogProviders, hiddenKeys });

    expect(getAllProviderModelRows(visible).map((row) => row.modelId)).not.toContain(
      "cursor/claude-opus-5",
    );
    expect(
      resolveSelectedModelLabel({
        providers: catalogProviders,
        selectedProvider: "omp",
        selectedModel: "cursor/claude-opus-5",
        isLoading: false,
      }),
    ).toBe("cursor/claude-opus-5");
  });
});
