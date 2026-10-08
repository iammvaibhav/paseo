import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE_ID,
  isAgentModeId,
  type AgentModeId,
} from "@getpaseo/protocol/agent-modes";
import type { RoutingPlacement, RoutingSuggestion } from "@getpaseo/protocol/routing";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { ComposerTextSource } from "@/composer/text-source";
import { getHostProjectId } from "@/projects/host-project-model";
import type { HostProjectListItem } from "@/projects/host-projects";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

// Fire once typing pauses this long; a new keystroke cancels the wait, and a
// reply for an older prompt is dropped. jev is cheap (~0.4 s), so this only
// avoids calls the user would never see.
const ROUTING_DEBOUNCE_MS = 1_000;
const ROUTING_MIN_PROMPT_CHARS = 15;
const ROUTING_CACHE_LIMIT = 50;

export const NEW_PROJECT_OPTION_ID = "routing:new_project";
export const SCRATCH_OPTION_ID = "routing:scratch";

/** Where the workspace goes when it is not an existing project the picker lists. */
export type RoutingTarget =
  | { kind: "project" }
  | { kind: "new_project"; serverId: string }
  | { kind: "scratch"; serverId: string };

const TARGET_PRESENTATION: Record<
  RoutingTarget["kind"],
  { label: string | null; optionId: string | null }
> = {
  project: { label: null, optionId: null },
  new_project: { label: "New project", optionId: NEW_PROJECT_OPTION_ID },
  scratch: { label: "Scratch", optionId: SCRATCH_OPTION_ID },
};

type RoutingStatus = "idle" | "waiting" | "loading" | "ready" | "error";

const suggestionCache = new Map<string, RoutingSuggestion>();

function rememberSuggestion(prompt: string, suggestion: RoutingSuggestion): void {
  suggestionCache.delete(prompt);
  suggestionCache.set(prompt, suggestion);
  if (suggestionCache.size > ROUTING_CACHE_LIMIT) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest !== undefined) suggestionCache.delete(oldest);
  }
}

/** "omp:anthropic/claude-opus-5-5" → { provider: "omp", model: "anthropic/claude-opus-5-5" }. */
export function parseRoutingModel(
  value: string | null,
): { provider: AgentProvider; model: string } | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  return {
    provider: value.slice(0, separator) as AgentProvider,
    model: value.slice(separator + 1),
  };
}

interface UseRoutingSuggestionResult {
  suggestion: RoutingSuggestion | null;
  status: RoutingStatus;
  error: string | null;
  /** Resolve the suggestion for the current prompt now (Enter): skips the pause. */
  settle: () => Promise<RoutingSuggestion | null>;
}

function useRoutingSuggestion(input: {
  serverId: string;
  textSource: ComposerTextSource;
  enabled: boolean;
}): UseRoutingSuggestionResult {
  const { serverId, textSource, enabled } = input;
  const prompt = useSyncExternalStore(textSource.subscribe, textSource.getSnapshot).trim();
  const [state, setState] = useState<{
    prompt: string;
    status: RoutingStatus;
    suggestion: RoutingSuggestion | null;
    error: string | null;
  }>({ prompt: "", status: "idle", suggestion: null, error: null });
  const sequenceRef = useRef(0);
  const inFlightRef = useRef<{ prompt: string; promise: Promise<RoutingSuggestion | null> } | null>(
    null,
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    (forPrompt: string): Promise<RoutingSuggestion | null> => {
      if (inFlightRef.current?.prompt === forPrompt) return inFlightRef.current.promise;
      const sequence = (sequenceRef.current += 1);
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client?.isConnected) return Promise.resolve(null);
      setState({ prompt: forPrompt, status: "loading", suggestion: null, error: null });
      const promise = client
        .suggestRouting(forPrompt)
        .then((suggestion) => {
          rememberSuggestion(forPrompt, suggestion);
          if (sequence === sequenceRef.current) {
            setState({ prompt: forPrompt, status: "ready", suggestion, error: null });
          }
          return suggestion;
        })
        .catch((error: unknown) => {
          if (sequence === sequenceRef.current) {
            setState({
              prompt: forPrompt,
              status: "error",
              suggestion: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return null;
        })
        .finally(() => {
          if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
        });
      inFlightRef.current = { prompt: forPrompt, promise };
      return promise;
    },
    [serverId],
  );

  useEffect(() => {
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = null;
    if (!enabled || prompt.length < ROUTING_MIN_PROMPT_CHARS) {
      sequenceRef.current += 1;
      setState({ prompt, status: "idle", suggestion: null, error: null });
      return;
    }
    const cached = suggestionCache.get(prompt);
    if (cached) {
      sequenceRef.current += 1;
      setState({ prompt, status: "ready", suggestion: cached, error: null });
      return;
    }
    // A newer prompt supersedes any in-flight request: its reply is dropped.
    sequenceRef.current += 1;
    setState((current) => ({ ...current, prompt, status: "waiting" }));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void run(prompt);
    }, ROUTING_DEBOUNCE_MS);
    return () => {
      clearTimeout(timerRef.current ?? undefined);
    };
  }, [enabled, prompt, run]);

  const settle = useCallback(async (): Promise<RoutingSuggestion | null> => {
    if (!enabled || prompt.length < ROUTING_MIN_PROMPT_CHARS) return null;
    const cached = suggestionCache.get(prompt);
    if (cached) return cached;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return run(prompt);
  }, [enabled, prompt, run]);

  const current = state.prompt === prompt ? state : null;
  return {
    suggestion: current?.suggestion ?? null,
    status: current?.status ?? "idle",
    error: current?.error ?? null,
    settle,
  };
}

interface TouchedControls {
  host: boolean;
  project: boolean;
  isolation: boolean;
  agentMode: boolean;
  model: boolean;
}

/** The composer selection the suggested model writes into. */
export interface RoutingComposerState {
  selectedProvider: AgentProvider | null;
  effectiveModelId: string;
  setProviderAndModelFromUser: (provider: AgentProvider, model: string) => void;
}

/** The listed-project picker as the screen computes it without routing. */
export interface RoutingProjectPickerInput {
  options: ComboboxOption[];
  selectedOptionId: string;
  triggerLabel: string;
  selectedProject: HostProjectListItem | null;
}

export interface NewWorkspaceRoutingInput {
  /** The host serves routing.suggest (features.routingSuggest). */
  supported: boolean;
  /** A fork carries its own setup; routing stays off. */
  forked: boolean;
  textSource: ComposerTextSource;
  /**
   * The host that answers routing.suggest: the Commander host, which sees the
   * whole fleet. Never the selected host: a suggestion moves the selection.
   */
  routingServerId: string;
  selectedServerId: string;
  /** Select a host without marking it as the user's choice. */
  selectHost: (serverId: string) => void;
  projectByOptionId: ReadonlyMap<string, HostProjectListItem>;
  /** Select a project option without marking it as the user's choice. */
  selectProjectOption: (optionId: string) => void;
  composerState: RoutingComposerState | null;
  projectPicker: RoutingProjectPickerInput;
}

export interface NewWorkspaceRouting {
  status: RoutingStatus;
  error: string | null;
  suggestion: RoutingSuggestion | null;
  target: RoutingTarget;
  agentMode: AgentModeId;
  agentModeOptions: ComboboxOption[];
  /** Isolation from the suggestion, until the user picks one. */
  suggestedIsolation: "local" | "worktree" | null;
  /** Options shown above the project list: New project, and Scratch when the host has none. */
  specialProjectOptions: ComboboxOption[];
  /** Picker label when the target is not an existing project. */
  targetLabel: string | null;
  /** Picker option id of the New project / Scratch target; null for a listed project. */
  targetOptionId: string | null;
  /** The user picked something: suggestions stop changing that control. */
  markTouched: (control: keyof TouchedControls) => void;
  /** Project picker selection of New project / Scratch; false for a normal project id. */
  selectSpecialProjectOption: (optionId: string) => boolean;
  selectAgentMode: (id: string) => void;
  /** Await the suggestion for the current prompt and apply it; true when it changed controls. */
  settle: () => Promise<boolean>;
  /** No suggested project is still waiting for its host's project list. */
  isApplied: boolean;
  /** The project picker with New project / Scratch folded in. */
  picker: RoutingProjectPickerInput;
}

function findProjectOptionId(
  projectByOptionId: ReadonlyMap<string, HostProjectListItem>,
  placement: RoutingPlacement,
): string | null {
  if (!placement.projectId) return null;
  for (const [optionId, project] of projectByOptionId) {
    if (getHostProjectId(project, placement.serverId) === placement.projectId) return optionId;
  }
  return null;
}

/**
 * Auto-selection for the New workspace screen: a jev placement suggestion
 * fills every control the user has not touched (host, project or New
 * project / Scratch, isolation, agent mode, model). Nothing is ever asked;
 * Enter creates whatever is selected.
 */
export function useNewWorkspaceRouting(input: NewWorkspaceRoutingInput): NewWorkspaceRouting {
  const {
    supported,
    forked,
    textSource,
    routingServerId,
    selectedServerId,
    selectHost,
    projectByOptionId,
    selectProjectOption,
    composerState,
    projectPicker,
  } = input;
  const enabled = supported && !forked;
  const composerModel = useMemo(
    () =>
      composerState
        ? {
            provider: composerState.selectedProvider,
            model: composerState.effectiveModelId,
            setProviderAndModel: composerState.setProviderAndModelFromUser,
          }
        : null,
    [composerState],
  );
  const routing = useRoutingSuggestion({ serverId: routingServerId, textSource, enabled });
  const touchedRef = useRef<TouchedControls>({
    host: false,
    project: false,
    isolation: false,
    agentMode: false,
    model: false,
  });
  const [target, setTarget] = useState<RoutingTarget>({ kind: "project" });
  const [agentMode, setAgentMode] = useState<AgentModeId>(DEFAULT_AGENT_MODE_ID);
  const [suggestedIsolation, setSuggestedIsolation] = useState<"local" | "worktree" | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<RoutingPlacement | null>(null);
  const lastAppliedModelRef = useRef<string | null>(null);
  const appliedSuggestionRef = useRef<RoutingSuggestion | null>(null);

  const markTouched = useCallback((control: keyof TouchedControls) => {
    touchedRef.current[control] = true;
    if (control === "project") setPendingPlacement(null);
  }, []);

  const applySuggestion = useCallback(
    (suggestion: RoutingSuggestion): boolean => {
      if (appliedSuggestionRef.current === suggestion) return false;
      appliedSuggestionRef.current = suggestion;
      const touched = touchedRef.current;
      const placement = suggestion.placement;
      if (!touched.host && placement.serverId !== selectedServerId) {
        selectHost(placement.serverId);
      }
      if (!touched.project) {
        setPendingPlacement(placement);
      }
      if (!touched.isolation) {
        setSuggestedIsolation(suggestion.isolation);
      }
      if (!touched.agentMode && isAgentModeId(suggestion.agentMode)) {
        setAgentMode(suggestion.agentMode);
      }
      const model = parseRoutingModel(suggestion.model);
      if (composerModel && model && !touched.model) {
        const userChanged =
          lastAppliedModelRef.current !== null &&
          lastAppliedModelRef.current !== `${composerModel.provider}:${composerModel.model}`;
        if (userChanged) {
          touched.model = true;
        } else if (
          composerModel.provider !== model.provider ||
          composerModel.model !== model.model
        ) {
          composerModel.setProviderAndModel(model.provider, model.model);
          lastAppliedModelRef.current = `${model.provider}:${model.model}`;
        } else {
          lastAppliedModelRef.current = `${model.provider}:${model.model}`;
        }
      }
      return true;
    },
    [composerModel, selectHost, selectedServerId],
  );

  useEffect(() => {
    if (routing.suggestion) applySuggestion(routing.suggestion);
  }, [applySuggestion, routing.suggestion]);

  // A suggested project can only be selected once its host is selected and
  // that host's project list is loaded; New project / Scratch need neither.
  useEffect(() => {
    if (!pendingPlacement || touchedRef.current.project) return;
    if (pendingPlacement.serverId !== selectedServerId) return;
    const optionId = findProjectOptionId(projectByOptionId, pendingPlacement);
    if (optionId) {
      selectProjectOption(optionId);
      setTarget({ kind: "project" });
      setPendingPlacement(null);
      return;
    }
    if (pendingPlacement.kind === "new_project" || pendingPlacement.kind === "scratch") {
      setTarget({ kind: pendingPlacement.kind, serverId: pendingPlacement.serverId });
      setPendingPlacement(null);
    }
  }, [pendingPlacement, projectByOptionId, selectProjectOption, selectedServerId]);

  const scratchListed = useMemo(() => {
    const placement = routing.suggestion?.placement;
    return placement?.kind === "scratch" && placement.projectId !== null;
  }, [routing.suggestion]);

  const specialProjectOptions = useMemo<ComboboxOption[]>(
    () => [
      {
        id: NEW_PROJECT_OPTION_ID,
        label: "New project",
        description: "Named from the prompt, created with git on this host",
      },
      ...(scratchListed
        ? []
        : [
            {
              id: SCRATCH_OPTION_ID,
              label: "Scratch",
              description: "This host's scratch area for one-off work",
            },
          ]),
    ],
    [scratchListed],
  );

  const selectSpecialProjectOption = useCallback(
    (optionId: string): boolean => {
      if (optionId !== NEW_PROJECT_OPTION_ID && optionId !== SCRATCH_OPTION_ID) {
        touchedRef.current.project = true;
        setPendingPlacement(null);
        setTarget({ kind: "project" });
        return false;
      }
      touchedRef.current.project = true;
      setPendingPlacement(null);
      setTarget({
        kind: optionId === NEW_PROJECT_OPTION_ID ? "new_project" : "scratch",
        serverId: selectedServerId,
      });
      return true;
    },
    [selectedServerId],
  );

  const selectAgentMode = useCallback((id: string) => {
    if (!isAgentModeId(id)) return;
    touchedRef.current.agentMode = true;
    setAgentMode(id);
  }, []);

  const settle = useCallback(async (): Promise<boolean> => {
    const suggestion = await routing.settle();
    return suggestion ? applySuggestion(suggestion) : false;
  }, [applySuggestion, routing]);

  const agentModeOptions = useMemo<ComboboxOption[]>(
    () =>
      AGENT_MODES.map((mode) => ({
        id: mode.id,
        label: mode.label,
        description: mode.description,
      })),
    [],
  );

  // The target follows the host: New project / Scratch on another host than
  // the selected one means the user moved the host after the suggestion.
  const effectiveTarget: RoutingTarget =
    target.kind !== "project" && target.serverId !== selectedServerId
      ? { kind: target.kind, serverId: selectedServerId }
      : target;

  const presentation = TARGET_PRESENTATION[effectiveTarget.kind];
  const picker = useMemo<RoutingProjectPickerInput>(() => {
    if (!enabled) return projectPicker;
    return {
      options: [...specialProjectOptions, ...projectPicker.options],
      selectedOptionId: presentation.optionId ?? projectPicker.selectedOptionId,
      triggerLabel: presentation.label ?? projectPicker.triggerLabel,
      selectedProject: presentation.optionId ? null : projectPicker.selectedProject,
    };
  }, [enabled, presentation, projectPicker, specialProjectOptions]);

  return {
    status: enabled ? routing.status : "idle",
    error: routing.error,
    suggestion: routing.suggestion,
    target: effectiveTarget,
    agentMode,
    agentModeOptions,
    suggestedIsolation,
    specialProjectOptions,
    targetLabel: presentation.label,
    targetOptionId: presentation.optionId,
    markTouched,
    selectSpecialProjectOption,
    selectAgentMode,
    settle,
    isApplied: pendingPlacement === null,
    picker,
  };
}
