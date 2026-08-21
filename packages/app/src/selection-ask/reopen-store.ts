import { create } from "zustand";

/**
 * Reopen requests from the asks track to the selection Ask popover host.
 *
 * The asks pill lives on the composer track bar while the popover host wraps
 * the stream, so prop drilling a click between them is not viable. Instead
 * the track publishes a request here and the popover host for the matching
 * source agent consumes (and clears) it, reopening the popover in answer
 * mode for that ask.
 */

export interface ReopenAskAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ReopenAskRequest {
  /** Agent whose panel hosts the asks track; its popover host consumes the request. */
  sourceAgentId: string;
  /** The ask agent to reopen in answer mode. */
  askAgentId: string;
  /** Viewport rect of the clicked row, used as the popover anchor. */
  anchorRect?: ReopenAskAnchorRect | null;
}

export interface DismissAskRequest {
  /** Agent whose panel hosts the asks track; its popover host consumes the request. */
  sourceAgentId: string;
  /** The ask agent to dismiss from the popover (archived while open). */
  askAgentId: string;
}

interface ReopenAskState {
  request: ReopenAskRequest | null;
  dismissRequest: DismissAskRequest | null;
  /**
   * The source-chat DOM Range captured when each ask was started, keyed by ask
   * agent id. Kept here (not in the popover) so it survives the popover being
   * dismissed and can power the reopened popover's "Jump to chat" control.
   */
  selectionRanges: Map<string, Range>;
  requestReopenAsk: (request: ReopenAskRequest) => void;
  /** Returns and clears the pending request when it targets `sourceAgentId`, else null. */
  consumeReopenAsk: (sourceAgentId: string) => ReopenAskRequest | null;
  /**
   * Publishes a dismiss request for an ask the asks track just archived; the
   * popover host for the matching source agent consumes it and closes the
   * popover when that ask is the one currently open.
   */
  requestAskDismiss: (request: DismissAskRequest) => void;
  /** Returns and clears the pending dismiss when it targets `sourceAgentId`, else null. */
  consumeAskDismiss: (sourceAgentId: string) => DismissAskRequest | null;
  /** Records the source selection for an ask, dropping ranges whose DOM is gone. */
  recordAskSelectionRange: (askAgentId: string, range: Range) => void;
  /** Returns and clears the stored selection range for an ask, if any. */
  consumeAskSelectionRange: (askAgentId: string) => Range | null;
}

export const useReopenAskStore = create<ReopenAskState>((set, get) => ({
  request: null,
  dismissRequest: null,
  selectionRanges: new Map(),
  requestReopenAsk: (request) => set({ request }),
  consumeReopenAsk: (sourceAgentId) => {
    const { request } = get();
    if (!request || request.sourceAgentId !== sourceAgentId) {
      return null;
    }
    set({ request: null });
    return request;
  },
  requestAskDismiss: (request) => set({ dismissRequest: request }),
  consumeAskDismiss: (sourceAgentId) => {
    const { dismissRequest } = get();
    if (!dismissRequest || dismissRequest.sourceAgentId !== sourceAgentId) {
      return null;
    }
    set({ dismissRequest: null });
    return dismissRequest;
  },
  recordAskSelectionRange: (askAgentId, range) => {
    const { selectionRanges } = get();
    const next = new Map(selectionRanges);
    if (typeof document !== "undefined") {
      for (const [storedId, stored] of next) {
        // Detached ranges pin dead DOM nodes forever; drop them on write so
        // the store only ever holds live targets.
        if (stored !== range && !document.contains(stored.startContainer)) {
          next.delete(storedId);
        }
      }
    }
    next.set(askAgentId, range);
    set({ selectionRanges: next });
  },
  consumeAskSelectionRange: (askAgentId) => {
    const { selectionRanges } = get();
    const range = selectionRanges.get(askAgentId);
    if (!range) {
      return null;
    }
    const next = new Map(selectionRanges);
    next.delete(askAgentId);
    set({ selectionRanges: next });
    return range;
  },
}));
