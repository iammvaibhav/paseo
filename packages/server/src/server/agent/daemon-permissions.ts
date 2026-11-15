import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

/**
 * A permission request the daemon raises and answers itself (a Paseo tool
 * waiting on the user), not one the provider session owns. It shows in the
 * agent's chat and pending list like any provider permission.
 */
export type DaemonPermissionRequest = Omit<AgentPermissionRequest, "provider">;

/**
 * Called when a client answers the request through `respondToPermission`.
 * Throwing rejects the response and keeps the request pending.
 */
export type DaemonPermissionResponder = (response: AgentPermissionResponse) => void;

export interface DaemonPermissionHandle {
  /** Removes the card and broadcasts `resolution`. No-op once settled. */
  settle(resolution: AgentPermissionResponse): void;
}

export interface DaemonPermissionHost {
  requestDaemonPermission(
    agentId: string,
    request: DaemonPermissionRequest,
    onResponse: DaemonPermissionResponder,
  ): DaemonPermissionHandle;
}
