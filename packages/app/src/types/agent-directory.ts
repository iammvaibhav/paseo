import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "name"
  | "shortDescription"
  | "status"
  | "lastActivityAt"
  | "lastUserMessageAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "stoppedBy"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
> & {
  pendingPermissionCount?: number;
};
