import { create } from "zustand";

/**
 * Reopen requests from the asks list to the selection Ask popover host.
 *
 * The collapsed asks list (SelectionAsksList) lives in the composer area while
 * the popover host wraps the stream, so prop drilling a click between them is
 * not viable. Instead the list publishes a request here and the popover host
 * for the matching source agent consumes (and clears) it, reopening the
 * popover in answer mode for that ask.
 */

export interface ReopenAskAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ReopenAskRequest {
  /** Agent whose panel hosts the asks list; its popover host consumes the request. */
  sourceAgentId: string;
  /** The ask agent to reopen in answer mode. */
  askAgentId: string;
  /** Viewport rect of the clicked row, used as the popover anchor. */
  anchorRect?: ReopenAskAnchorRect | null;
}

interface ReopenAskState {
  request: ReopenAskRequest | null;
  requestReopenAsk: (request: ReopenAskRequest) => void;
  /** Returns and clears the pending request when it targets `sourceAgentId`, else null. */
  consumeReopenAsk: (sourceAgentId: string) => ReopenAskRequest | null;
}

export const useReopenAskStore = create<ReopenAskState>((set, get) => ({
  request: null,
  requestReopenAsk: (request) => set({ request }),
  consumeReopenAsk: (sourceAgentId) => {
    const { request } = get();
    if (!request || request.sourceAgentId !== sourceAgentId) {
      return null;
    }
    set({ request: null });
    return request;
  },
}));
