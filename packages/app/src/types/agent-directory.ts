import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "name"
  | "shortDescription"
  | "status"
  | "backgroundWork"
  | "turn"
  | "lastActivityAt"
  | "lastUserMessageAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "stoppedBy"
  | "bucket"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
  | "reminder"
> & {
  pendingPermissionCount?: number;
};
