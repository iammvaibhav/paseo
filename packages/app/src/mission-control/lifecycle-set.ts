import { getHostRuntimeStore } from "@/runtime/host-runtime";

export async function setAgentLifecycle(
  serverId: string,
  agentId: string,
  action: "done" | "clear",
  extraAgentIds?: string[],
): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    return;
  }
  const payload = await client.missionControlLifecycleSet({
    serverId,
    agentId,
    ...(extraAgentIds && extraAgentIds.length > 0 ? { agentIds: extraAgentIds } : {}),
    action,
  });
  if (!payload.ok) {
    throw new Error(payload.error ?? "Failed to update agent");
  }
}
