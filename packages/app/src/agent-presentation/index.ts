import { useShallow } from "zustand/shallow";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { useProviderIcon } from "@/components/provider-icons";
import { useMissionControlCentralConfig } from "@/mission-control/central-config";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore, selectAgentTurnPresentation, type Agent } from "@/stores/session-store";
import { resolveSessionAgent } from "@/utils/agent-snapshots";
import { formatProviderLabel } from "@/utils/provider-label";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { resolveAgentLabel, resolveAgentTabTooltip } from "./title";

export function useAgentDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  useTranslation();
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const agent = resolveSessionAgent(session, target.agentId);
      return {
        provider: agent?.provider ?? "codex",
        title: agent?.title ?? null,
        name: agent?.name ?? null,
        status: agent?.status ?? null,
        backgroundWork: agent?.backgroundWork,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        attentionReason: agent?.attentionReason ?? null,
        stoppedBy: agent?.stoppedBy ?? null,
        bucket: agent?.bucket ?? null,
        isTurnActive: selectAgentTurnPresentation(session, target.agentId).isActive,
      };
    }),
  );
  const icon = useProviderIcon(descriptorState.provider, context.serverId);
  const hideAgentNames = useMissionControlCentralConfig().config?.hideAgentNames === true;
  return buildAgentDescriptor({ ...descriptorState, icon, hideAgentNames });
}

export function buildAgentDescriptor(input: {
  provider: Agent["provider"];
  title: string | null;
  name: string | null;
  status: Agent["status"] | null;
  backgroundWork?: Agent["backgroundWork"];
  pendingPermissionCount: number;
  attentionReason: Agent["attentionReason"];
  stoppedBy: Agent["stoppedBy"];
  bucket: Agent["bucket"] | null;
  isTurnActive: boolean;
  icon: PanelDescriptor["icon"];
  hideAgentNames: boolean;
}): PanelDescriptor {
  const label = resolveAgentLabel(input.title, input.name);
  const providerTooltip = `${formatProviderLabel(input.provider)} agent`;
  const statusBucket = input.status
    ? deriveSidebarStateBucket({
        bucket: input.bucket,
        status: input.isTurnActive ? "running" : input.status,
        backgroundWork: input.backgroundWork,
        pendingPermissionCount: input.pendingPermissionCount,
        attentionReason: input.attentionReason,
        stoppedBy: input.stoppedBy,
      })
    : null;

  return {
    label: label ?? "",
    subtitle:
      statusBucket === "running" && !input.isTurnActive && input.status !== "running"
        ? i18n.t("message.backgroundWork.running")
        : providerTooltip,
    tooltip: resolveAgentTabTooltip({
      label,
      name: input.name,
      fallbackTooltip: providerTooltip,
      hideAgentNames: input.hideAgentNames,
    }),
    titleState: label ? "ready" : "loading",
    icon: input.icon,
    statusBucket,
  };
}
