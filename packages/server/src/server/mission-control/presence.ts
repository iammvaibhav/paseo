import type { ClientPresenceState } from "../agent-attention-policy.js";

/**
 * Presence contract consumed by the approval gate (approvals.ts) to downgrade
 * auto-mode sends back to ask: if a user is watching the target agent or the
 * agent's last run was cancelled by the user, the proposal always asks.
 *
 * Owned jointly: ProtocolStoreSlice defines the interface; ToolsDetectorsSlice
 * provides the concrete factory (createMissionControlPresenceSource) backed by
 * WebSocketServer client-activity aggregation + the store's stop-origin ledger.
 */
export interface MissionControlPresenceSource {
  /** True when any trusted connected client has the agent open with the app visible. */
  isAgentFocused(agentId: string): boolean;
  /** Who cancelled the agent's last run, or null when never cancelled. */
  getStoppedBy(agentId: string): "user" | "machinery" | "system" | null;
}

/** Inputs the factory closes over; injected at bootstrap wiring time. */
export interface MissionControlPresenceSourceInput {
  /** Live aggregation across connected client sessions (heartbeat state). */
  isAgentFocused: (agentId: string) => boolean;
  /** Persisted cancel origin for the agent's last run (mission-control store). */
  readStopOrigin: (agentId: string) => "user" | "machinery" | "system" | null;
}

/**
 * Whether any connected client is currently viewing the agent: the client's
 * heartbeat reports `focusedAgentId` and the app is visible. Pure helper over
 * the aggregated per-client presence states.
 */
export function isUserViewingAgent(
  agentId: string,
  states: readonly ClientPresenceState[],
): boolean {
  return states.some((state) => state.appVisible && state.focusedAgentId === agentId);
}

/**
 * Concrete presence source for the approval gate. `isAgentFocused` aggregates
 * live client heartbeats (WebSocketServer.anyClientFocusedOnAgent);
 * `readStopOrigin` reads the persisted cancel origin from the store.
 */
export function createMissionControlPresenceSource(
  input: MissionControlPresenceSourceInput,
): MissionControlPresenceSource {
  return {
    isAgentFocused: (agentId) => input.isAgentFocused(agentId),
    getStoppedBy: (agentId) => input.readStopOrigin(agentId),
  };
}
