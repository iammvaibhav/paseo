import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  PARENT_AGENT_ID_LABEL,
  SELECTION_ASK_LABEL,
  SELECTION_ASK_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import {
  mergeSelectionAskPreference,
  resolveEffectiveSelectionAskPreference,
  type SelectionAskModelPreference,
} from "@/create-agent-preferences/preferences";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { toErrorMessage } from "@/utils/error-messages";
import { emitComposerPrefill } from "@/workspace/plannotator-feedback";
import {
  buildAskThreadMessages,
  buildSelectionAskBlock,
  buildSelectionAskPrompt,
  buildSelectionAskTitle,
  type AskMessage,
} from "./format";
import { useReopenAskStore } from "./reopen-store";

/**
 * Source key the popover's forked agent registers under in the focused
 * timeline sync. Kept out of the workspace's tab membership so the ask stays
 * live (subscribed + timeline catch-up) while the popover is open, and drops
 * out when it closes.
 */
const SELECTION_ASK_TIMELINE_SOURCE = "selection-ask-popover";

/** What the selection popover needs to know about the chat it is attached to. */
export interface SelectionAskConfig {
  serverId: string;
  sourceAgentId: string;
  cwd: string;
  workspaceId?: string | null;
  projectKey?: string | null;
  /** The source agent's current selection; the popover's model defaults to it. */
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinkingOptionId?: string | null;
}

export interface ActiveSelection {
  markdown: string;
  /** Kept so the popover can re-anchor while the user scrolls the stream. */
  range: Range;
}

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ThinkingOptionEntry {
  id: string;
  label: string;
}

function toThinkingOptionEntries(
  options: { id: string; label?: string | null; isDefault?: boolean }[] | undefined,
): ThinkingOptionEntry[] {
  if (!options || options.length === 0) {
    return [];
  }
  return options.map((option) => ({
    id: option.id,
    label: formatThinkingOptionLabel(option),
  }));
}

function resolveDefaultThinkingOption(
  model:
    | {
        thinkingOptions?: { id: string; isDefault?: boolean }[] | null;
        defaultThinkingOptionId?: string | null;
      }
    | undefined,
  fallback: string | null,
): string | null {
  const options = model?.thinkingOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  if (fallback && options.some((option) => option.id === fallback)) {
    return fallback;
  }
  return (
    model?.defaultThinkingOptionId ??
    options.find((option) => option.isDefault)?.id ??
    options[0]?.id ??
    null
  );
}

export interface SelectionAskModelState {
  modelProviders: ReturnType<typeof buildSelectableProviderSelectorProviders>;
  selectedProvider: string;
  selectedModel: string;
  selectedThinkingOptionId: string | null;
  thinkingOptions: ThinkingOptionEntry[];
  isModelLoading: boolean;
  onSelectModel: (provider: AgentProvider, modelId: string) => void;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
}

export interface SelectionAskState extends SelectionAskModelState {
  selection: ActiveSelection | null;
  anchorRect: AnchorRect | null;
  comment: string;
  setComment: (text: string) => void;
  followUp: string;
  setFollowUp: (text: string) => void;
  askAgentId: string | null;
  askTitle: string | null;
  askStatus: Agent["status"] | null;
  askMessages: AskMessage[];
  isAskRunning: boolean;
  isStartingAsk: boolean;
  isSendingFollowUp: boolean;
  error: string | null;
  /** Whether a "Jump to chat" target exists and is still attached to the DOM. */
  canJumpToSelection: boolean;
  /** Scrolls the source chat's selection into view; no-op when the range is gone. */
  jumpToSelection: () => void;
  showSelection: (input: { markdown: string; range: Range }) => void;
  recomputeAnchorRect: () => void;
  addToComposer: () => void;
  startAsk: () => Promise<void>;
  sendFollowUp: () => Promise<void>;
  openInTab: () => void;
  dismiss: () => void;
}

function readSelectionAskAnchorRect(range: Range): AnchorRect {
  const rect = range.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

const REOPEN_FALLBACK_WIDTH = 380;
const REOPEN_FALLBACK_MARGIN = 24;

// The asks list normally anchors a reopened popover at the clicked row; this
// is the defensive fallback when no row rect is available.
function fallbackReopenAnchorRect(): AnchorRect {
  if (typeof window === "undefined") {
    return { top: 0, left: 0, width: 0, height: 0 };
  }
  return {
    top: 96,
    left: Math.max(8, window.innerWidth - REOPEN_FALLBACK_WIDTH - REOPEN_FALLBACK_MARGIN),
    width: 0,
    height: 0,
  };
}

export function useSelectionAsk(config: SelectionAskConfig): SelectionAskState {
  const client = useHostRuntimeClient(config.serverId);
  const [selection, setSelection] = useState<ActiveSelection | null>(null);
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const [comment, setComment] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [askAgentId, setAskAgentId] = useState<string | null>(null);
  const [isStartingAsk, setIsStartingAsk] = useState(false);
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedThinkingOptionId, setSelectedThinkingOptionId] = useState<string | null>(null);
  // Scope key the model selection was last seeded for. Re-seeding happens once
  // per scope so a late-arriving workspaceId/projectKey is honored, while a
  // later preference update never clobbers the in-popover choice.
  const seededPrefsScopeRef = useRef<string | null>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  // The source-chat selection captured when the ask was started, restored on
  // reopen so the popover can offer "Jump to chat". Distinct from
  // selectionRangeRef (which anchors the popover in compose mode).
  const [jumpRange, setJumpRange] = useState<Range | null>(null);

  const providerSnapshot = useProvidersSnapshot(config.serverId, {
    enabled: selection !== null,
    cwd: config.cwd,
  });

  const modelProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(providerSnapshot.entries),
    [providerSnapshot.entries],
  );

  const preferenceScope = useMemo(
    () => ({
      workspaceId: config.workspaceId ?? null,
      projectKey: config.projectKey ?? null,
    }),
    [config.projectKey, config.workspaceId],
  );
  const preferenceScopeKey = `${preferenceScope.workspaceId ?? ""}\u0000${preferenceScope.projectKey ?? ""}`;

  const { preferences, isLoading: isPreferencesLoading, updatePreferences } = useFormPreferences();

  // Seed the model selection once per scope: the remembered choice
  // (workspace > project > global) wins over the source agent's current
  // model. Waiting for the reactive preferences to load keeps the remembered
  // model from being skipped while the query is still in flight, and seeding
  // again when the scope key changes honors a workspaceId/projectKey that
  // arrives after mount instead of locking in an empty-scope default.
  useEffect(() => {
    if (isPreferencesLoading || seededPrefsScopeRef.current === preferenceScopeKey) {
      return;
    }
    seededPrefsScopeRef.current = preferenceScopeKey;
    const remembered = resolveEffectiveSelectionAskPreference(preferences, preferenceScope);
    setSelectedProvider(remembered.provider ?? config.defaultProvider ?? "");
    setSelectedModel(remembered.model ?? config.defaultModel ?? "");
    setSelectedThinkingOptionId(
      remembered.thinkingOptionId ?? config.defaultThinkingOptionId ?? null,
    );
  }, [
    config.defaultModel,
    config.defaultProvider,
    config.defaultThinkingOptionId,
    isPreferencesLoading,
    preferenceScope,
    preferenceScopeKey,
    preferences,
  ]);

  const persistSelectionAskPreference = useCallback(
    (next: SelectionAskModelPreference) => {
      void updatePreferences((current) =>
        mergeSelectionAskPreference({
          preferences: current,
          selectionAsk: next,
          scope: preferenceScope,
        }),
      );
    },
    [preferenceScope, updatePreferences],
  );

  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      const entry = providerSnapshot.entries?.find((candidate) => candidate.provider === provider);
      const model = entry?.models?.find((candidate) => candidate.id === modelId);
      const options = model?.thinkingOptions ?? [];
      const nextThinkingOptionId = options.some((option) => option.id === selectedThinkingOptionId)
        ? selectedThinkingOptionId
        : resolveDefaultThinkingOption(model, null);
      setSelectedProvider(provider);
      setSelectedModel(modelId);
      setSelectedThinkingOptionId(nextThinkingOptionId);
      persistSelectionAskPreference({
        provider,
        model: modelId,
        thinkingOptionId: nextThinkingOptionId ?? undefined,
      });
    },
    [persistSelectionAskPreference, providerSnapshot.entries, selectedThinkingOptionId],
  );

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      setSelectedThinkingOptionId(thinkingOptionId);
      persistSelectionAskPreference({ thinkingOptionId });
    },
    [persistSelectionAskPreference],
  );

  // Once the provider catalog is in, make sure the selected provider/model are
  // actually selectable; otherwise fall back to the remembered/default choice.
  useEffect(() => {
    if (modelProviders.length === 0) {
      return;
    }
    const providerEntry =
      modelProviders.find((entry) => entry.id === selectedProvider) ?? modelProviders[0];
    if (!providerEntry) {
      return;
    }
    const rows =
      providerEntry.modelSelection.kind === "models" ? providerEntry.modelSelection.rows : [];
    const modelRow =
      rows.find((row) => row.modelId === selectedModel) ??
      rows.find((row) => row.isDefault) ??
      rows[0];
    const nextProvider = providerEntry.id;
    const nextModel = modelRow?.modelId ?? "";
    if (nextProvider === selectedProvider && nextModel === selectedModel) {
      return;
    }
    const entry = providerSnapshot.entries?.find(
      (candidate) => candidate.provider === nextProvider,
    );
    const model = entry?.models?.find((candidate) => candidate.id === nextModel);
    setSelectedProvider(nextProvider);
    setSelectedModel(nextModel);
    setSelectedThinkingOptionId((current) => resolveDefaultThinkingOption(model, current));
  }, [modelProviders, providerSnapshot.entries, selectedModel, selectedProvider]);

  const thinkingOptions = useMemo(() => {
    const entry = providerSnapshot.entries?.find(
      (candidate) => candidate.provider === selectedProvider,
    );
    const model = entry?.models?.find((candidate) => candidate.id === selectedModel);
    return toThinkingOptionEntries(model?.thinkingOptions);
  }, [providerSnapshot.entries, selectedModel, selectedProvider]);

  const clearAskTimelineSubscription = useCallback(() => {
    useSessionStore
      .getState()
      .sessions[config.serverId]?.viewedTimelineSync?.replaceVisibleAgentIds(
        SELECTION_ASK_TIMELINE_SOURCE,
        [],
      );
  }, [config.serverId]);

  const showSelection = useCallback(
    (input: { markdown: string; range: Range }) => {
      // Ignore mouseups that still carry the already-shown selection (e.g. a
      // click inside the popover's model browser) — only a genuinely new
      // selection replaces the current one, so answer mode is never reset by
      // a stale mouseup. `dismiss` clears the stored range, so re-selecting
      // the same text after dismissal still shows the popover again.
      const previous = selectionRangeRef.current;
      if (
        previous &&
        previous.startContainer === input.range.startContainer &&
        previous.startOffset === input.range.startOffset &&
        previous.endContainer === input.range.endContainer &&
        previous.endOffset === input.range.endOffset
      ) {
        return;
      }
      selectionRangeRef.current = input.range;
      setSelection({ markdown: input.markdown, range: input.range });
      setAnchorRect(readSelectionAskAnchorRect(input.range));
      setJumpRange(null);
      // A fresh selection starts back in compose mode; the previous ask's popover
      // (if any) is replaced rather than stacked.
      clearAskTimelineSubscription();
      setAskAgentId(null);
      // An ask started against the previous selection may still be in flight;
      // its result is dropped by startAsk's stale-range guard, so compose mode
      // must not inherit the pending state.
      setIsStartingAsk(false);
      setComment("");
      setFollowUp("");
      setError(null);
    },
    [clearAskTimelineSubscription],
  );

  const recomputeAnchorRect = useCallback(() => {
    const range = selectionRangeRef.current;
    if (range) {
      setAnchorRect(readSelectionAskAnchorRect(range));
    }
  }, []);

  const dismiss = useCallback(() => {
    selectionRangeRef.current = null;
    setSelection(null);
    setAnchorRect(null);
    setJumpRange(null);
    clearAskTimelineSubscription();
    setAskAgentId(null);
    setIsStartingAsk(false);
    setComment("");
    setFollowUp("");
    setError(null);
  }, [clearAskTimelineSubscription]);

  // The asks list reopens the popover through the reopen store: consume the
  // request targeting this source agent, open in answer mode anchored at the
  // clicked row, and register the ask's timeline like a freshly started ask so
  // its status and stream stay live.
  const handleReopenAskRequest = useCallback(() => {
    const request = useReopenAskStore.getState().consumeReopenAsk(config.sourceAgentId);
    if (!request) {
      return;
    }
    selectionRangeRef.current = null;
    setSelection(null);
    setAnchorRect(request.anchorRect ?? fallbackReopenAnchorRect());
    setAskAgentId(request.askAgentId);
    // Restore the source-chat selection captured when the ask was started, so
    // "Jump to chat" can scroll it back into view while it is still attached
    // to the DOM. The popover itself stays anchored at the clicked row.
    setJumpRange(useReopenAskStore.getState().consumeAskSelectionRange(request.askAgentId));
    setComment("");
    setFollowUp("");
    setError(null);
    useSessionStore
      .getState()
      .sessions[config.serverId]?.viewedTimelineSync?.replaceVisibleAgentIds(
        SELECTION_ASK_TIMELINE_SOURCE,
        [request.askAgentId],
      );
    void getHostRuntimeStore()
      .fetchAgentTimeline(config.serverId, request.askAgentId, planTimelineTailFetch())
      .catch(() => undefined);
  }, [config.serverId, config.sourceAgentId]);

  useEffect(() => {
    // Deliver a request published before this host mounted, then keep listening.
    handleReopenAskRequest();
    return useReopenAskStore.subscribe(handleReopenAskRequest);
  }, [handleReopenAskRequest]);

  // The asks list dismisses (archives) an ask that may be open in this popover.
  // Consume the dismiss request targeting this source agent and close the
  // popover when the archived ask is the one currently open. Requests for
  // other asks (or when no ask is open) are consumed and dropped.
  const handleAskDismissRequest = useCallback(() => {
    const request = useReopenAskStore.getState().consumeAskDismiss(config.sourceAgentId);
    if (!request || request.askAgentId !== askAgentId) {
      return;
    }
    dismiss();
  }, [askAgentId, config.sourceAgentId, dismiss]);

  useEffect(() => {
    // Deliver a dismiss published before this host mounted, then keep listening.
    handleAskDismissRequest();
    return useReopenAskStore.subscribe(handleAskDismissRequest);
  }, [handleAskDismissRequest]);

  const addToComposer = useCallback(() => {
    if (!selection) {
      return;
    }
    const block = buildSelectionAskBlock({ selection: selection.markdown, comment });
    if (!block) {
      return;
    }
    const draftKey = buildDraftStoreKey({
      serverId: config.serverId,
      agentId: config.sourceAgentId,
    });
    const existing = useDraftStore.getState().getDraftInput(draftKey);
    const nextText =
      existing?.text && existing.text.trim().length > 0
        ? `${existing.text.trim()}\n\n${block}`
        : block;
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: {
        text: nextText,
        attachments: existing?.attachments ?? [],
      },
    });
    emitComposerPrefill({ draftKey, text: nextText });
    dismiss();
  }, [comment, config.serverId, config.sourceAgentId, dismiss, selection]);

  const startAsk = useCallback(async () => {
    if (!selection || !client) {
      return;
    }
    const startedRange = selectionRangeRef.current;
    setIsStartingAsk(true);
    setError(null);
    try {
      const prompt = buildSelectionAskPrompt({
        selection: selection.markdown,
        question: comment,
      });
      const labels = {
        [PARENT_AGENT_ID_LABEL]: config.sourceAgentId,
        [SELECTION_ASK_LABEL]: "1",
        [SELECTION_ASK_SOURCE_LABEL]: config.sourceAgentId,
      };
      const overrides: {
        provider?: AgentProvider;
        model?: string;
        thinkingOptionId?: string;
        title?: string;
      } = {};
      if (selectedProvider) {
        overrides.provider = selectedProvider as AgentProvider;
      }
      if (selectedModel) {
        overrides.model = selectedModel;
      }
      if (selectedThinkingOptionId) {
        overrides.thinkingOptionId = selectedThinkingOptionId;
      }
      const title = buildSelectionAskTitle({
        question: comment,
        selection: selection.markdown,
      });
      if (title) {
        overrides.title = title;
      }
      const result = await client.forkAgent(config.sourceAgentId, prompt, {
        labels,
        overrides,
      });
      // The popover may have been dismissed or re-anchored to a fresh
      // selection while the fork RPC was in flight. The fork still runs on
      // the server, but it is orphaned: never resurrect it over the new
      // state (its timeline subscription and stream would leak into the new
      // selection's popover).
      if (selectionRangeRef.current !== startedRange) {
        return;
      }
      setAskAgentId(result.agentId);
      // Remember the source selection for this ask so a later reopen from the
      // asks list can offer "Jump to chat" while the range is still live.
      if (
        startedRange &&
        typeof document !== "undefined" &&
        document.contains(startedRange.startContainer)
      ) {
        useReopenAskStore.getState().recordAskSelectionRange(result.agentId, startedRange);
      }
      // Make the fresh fork's timeline visible, the same way the agent panel
      // does when an agent opens: register it with the focused timeline sync
      // (selective subscription + catch-up fetches) and fetch its tail so the
      // agent record and stream land in the session store. Without this the
      // popover never sees the agent's status or streamed answer.
      useSessionStore
        .getState()
        .sessions[config.serverId]?.viewedTimelineSync?.replaceVisibleAgentIds(
          SELECTION_ASK_TIMELINE_SOURCE,
          [result.agentId],
        );
      void getHostRuntimeStore()
        .fetchAgentTimeline(config.serverId, result.agentId, planTimelineTailFetch())
        .catch(() => undefined);
    } catch (caught) {
      if (selectionRangeRef.current === startedRange) {
        setError(toErrorMessage(caught));
      }
    } finally {
      setIsStartingAsk(false);
    }
  }, [
    client,
    comment,
    config.serverId,
    config.sourceAgentId,
    selectedModel,
    selectedProvider,
    selectedThinkingOptionId,
    selection,
  ]);

  const sendFollowUp = useCallback(async () => {
    const text = followUp.trim();
    if (!text || !askAgentId || !client) {
      return;
    }
    setIsSendingFollowUp(true);
    setError(null);
    try {
      await client.sendAgentMessage(askAgentId, text);
      setFollowUp("");
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setIsSendingFollowUp(false);
    }
  }, [askAgentId, client, followUp]);

  const openInTab = useCallback(() => {
    if (!askAgentId) {
      return;
    }
    // Dismiss before navigating: the popover's job is done once the ask opens
    // as a real tab, and dismissing first guarantees the host is torn down
    // (timeline subscription released) even if the route change unmounts it.
    dismiss();
    navigateToAgent({ serverId: config.serverId, agentId: askAgentId });
  }, [askAgentId, config.serverId, dismiss]);

  const askAgent = useSessionStore((state) =>
    askAgentId ? state.sessions[config.serverId]?.agents.get(askAgentId) : undefined,
  );
  const askStream = useSessionStore((state) =>
    askAgentId ? state.sessions[config.serverId]?.agentStreamTail.get(askAgentId) : undefined,
  );
  const askHead = useSessionStore((state) =>
    askAgentId ? state.sessions[config.serverId]?.agentStreamHead.get(askAgentId) : undefined,
  );
  const askMessages = useMemo(
    () => buildAskThreadMessages(askStream, askHead),
    [askHead, askStream],
  );

  const canJumpToSelection = useMemo(() => {
    const range = jumpRange;
    return (
      range !== null && typeof document !== "undefined" && document.contains(range.startContainer)
    );
  }, [jumpRange]);

  const jumpToSelection = useCallback(() => {
    const range = jumpRange;
    if (!range || typeof document === "undefined" || !document.contains(range.startContainer)) {
      return;
    }
    const node = range.startContainer;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [jumpRange]);

  return {
    selection,
    anchorRect,
    comment,
    setComment,
    followUp,
    setFollowUp,
    askAgentId,
    askTitle: askAgent?.title ?? askAgent?.name ?? null,
    askStatus: askAgent?.status ?? null,
    askMessages,
    isAskRunning: askAgent?.status === "running",
    isStartingAsk,
    isSendingFollowUp,
    error,
    canJumpToSelection,
    jumpToSelection,
    showSelection,
    recomputeAnchorRect,
    addToComposer,
    startAsk,
    sendFollowUp,
    openInTab,
    dismiss,
    modelProviders,
    selectedProvider,
    selectedModel,
    selectedThinkingOptionId,
    thinkingOptions,
    isModelLoading: providerSnapshot.isLoading || providerSnapshot.isFetching,
    onSelectModel: handleSelectModel,
    onSelectThinkingOption: handleSelectThinkingOption,
  };
}
