import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useBrowserStore } from "@/stores/browser-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  clearPlannotatorBrowserSession,
  getPlannotatorBrowserSessionBySessionId,
} from "@/workspace/open-file-in-plannotator";

export type PlannotatorFeedbackMode = "auto-send" | "compose";

export interface PlannotatorSessionEventPayload {
  sessionId: string;
  kind: "annotate";
  path?: string;
  agentId?: string;
  workspaceKey?: string;
  event: "feedback" | "closed";
  decision?: "approved" | "annotated" | "dismissed" | "block";
  feedback?: string;
  raw?: unknown;
}

export interface HandlePlannotatorSessionEventInput {
  serverId: string;
  event: PlannotatorSessionEventPayload;
  feedbackMode: PlannotatorFeedbackMode;
  sendAgentMessage: (agentId: string, text: string) => Promise<void>;
  toast?: {
    show?: (message: string) => void;
    error?: (message: string) => void;
  };
}

/**
 * Route Plannotator session completion into the agent loop, then tear down the tab.
 */
export async function handlePlannotatorSessionEvent(
  input: HandlePlannotatorSessionEventInput,
): Promise<void> {
  const { event } = input;
  const session = getPlannotatorBrowserSessionBySessionId(event.sessionId);
  clearPlannotatorBrowserSession(event.sessionId);

  if (event.event === "feedback") {
    await deliverFeedback(input);
  }

  const browserId = session?.browserId ?? `plannotator-${event.sessionId}`;
  closePlannotatorBrowserTab({
    browserId,
    workspaceKey: session?.workspaceKey ?? event.workspaceKey ?? null,
  });
}

async function deliverFeedback(input: HandlePlannotatorSessionEventInput): Promise<void> {
  const { event, feedbackMode, serverId } = input;
  const text = (event.feedback ?? "").trim();
  const agentId = event.agentId?.trim() || null;

  if (!text) {
    if (event.decision === "approved") {
      input.toast?.show?.("Plannotator: approved");
    }
    return;
  }

  if (!agentId) {
    input.toast?.show?.(
      "Plannotator feedback ready, but no agent was linked — open an agent and paste it.",
    );
    return;
  }

  if (feedbackMode === "compose") {
    prefillAgentComposer({ serverId, agentId, text });
    input.toast?.show?.("Plannotator feedback prefilled in the composer");
    return;
  }

  try {
    await input.sendAgentMessage(agentId, text);
    input.toast?.show?.("Plannotator feedback sent to the agent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.toast?.error?.(`Failed to send Plannotator feedback: ${message}`);
    prefillAgentComposer({ serverId, agentId, text });
  }
}

function prefillAgentComposer(input: { serverId: string; agentId: string; text: string }): void {
  const draftKey = buildDraftStoreKey({
    serverId: input.serverId,
    agentId: input.agentId,
  });
  const existing = useDraftStore.getState().getDraftInput(draftKey);
  const nextText =
    existing?.text && existing.text.trim().length > 0
      ? `${existing.text.trim()}\n\n${input.text}`
      : input.text;
  useDraftStore.getState().saveDraftInput({
    draftKey,
    draft: {
      text: nextText,
      attachments: existing?.attachments ?? [],
    },
  });
  emitComposerPrefill({ draftKey, text: nextText });
}

function closePlannotatorBrowserTab(input: {
  browserId: string;
  workspaceKey: string | null;
}): void {
  if (input.workspaceKey) {
    const layoutState = useWorkspaceLayoutStore.getState();
    const layout = layoutState.layoutByWorkspace[input.workspaceKey];
    if (layout) {
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind === "browser" && tab.target.browserId === input.browserId) {
          layoutState.closeTab(input.workspaceKey, tab.tabId);
        }
      }
    }
  }
  useBrowserStore.getState().removeBrowser(input.browserId);
}

// --- composer prefill pub/sub ---

type PrefillListener = (payload: { draftKey: string; text: string }) => void;
const prefillListeners = new Set<PrefillListener>();

export function emitComposerPrefill(payload: { draftKey: string; text: string }): void {
  for (const listener of prefillListeners) {
    try {
      listener(payload);
    } catch {
      // ignore
    }
  }
}

export function subscribeComposerPrefill(listener: PrefillListener): () => void {
  prefillListeners.add(listener);
  return () => {
    prefillListeners.delete(listener);
  };
}
