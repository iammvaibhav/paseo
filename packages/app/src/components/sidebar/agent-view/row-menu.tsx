import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Archive, CircleCheck, Copy, ExternalLink, Square } from "lucide-react-native";
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import type { LifecycleRow } from "@/mission-control/lifecycle";
import { setAgentLifecycle } from "@/mission-control/lifecycle-set";
import { buildAgentReference, resolveBoardRowMenuActions } from "@/mission-control/row-menu";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedArchive = withUnistyles(Archive);
const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedSquare = withUnistyles(Square);

const menuIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_OPEN_ICON = <ThemedExternalLink size={14} uniProps={menuIconMapping} />;
const MENU_COPY_ICON = <ThemedCopy size={14} uniProps={menuIconMapping} />;
const MENU_STOP_ICON = <ThemedSquare size={14} uniProps={menuIconMapping} />;
const MENU_CIRCLE_CHECK_ICON = <ThemedCircleCheck size={14} uniProps={menuIconMapping} />;
const MENU_ARCHIVE_ICON = <ThemedArchive size={14} uniProps={menuIconMapping} />;

export interface SidebarAgentViewRowMenuProps {
  row: LifecycleRow;
  onOpen: () => void;
}

export const SidebarAgentViewRowMenu = memo(function SidebarAgentViewRowMenu({
  row,
  onOpen,
}: SidebarAgentViewRowMenuProps): ReactElement {
  const { agent } = row;
  const { t } = useTranslation();
  const toast = useToast();
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();

  const menuActions = resolveBoardRowMenuActions(row);
  const isArchiving = isArchivingAgent({ serverId: agent.serverId, agentId: agent.id });

  const handleMarkDone = useCallback(() => {
    void setAgentLifecycle(agent.serverId, agent.id, "done").catch(() => {});
  }, [agent.id, agent.serverId]);

  const handleCopyReference = useCallback(() => {
    void copyToClipboard(buildAgentReference(agent))
      .then(() => toast.copied("Reference copied"))
      .catch(() => toast.error("Unable to copy reference"));
  }, [agent, toast]);

  const handleStop = useCallback(() => {
    const client = getHostRuntimeStore().getClient(agent.serverId);
    if (!client) {
      return;
    }
    void client.cancelAgent(agent.id).catch(() => {});
  }, [agent.id, agent.serverId]);

  const handleClear = useCallback(() => {
    void setAgentLifecycle(agent.serverId, agent.id, "clear").catch(() => {});
  }, [agent.id, agent.serverId]);

  const handleArchive = useCallback(() => {
    void archiveAgent({ serverId: agent.serverId, agentId: agent.id }).catch(() => {});
  }, [agent.id, agent.serverId, archiveAgent]);

  return (
    <ContextMenuContent
      align="start"
      minWidth={180}
      testID={`sidebar-agent-view-row-menu-${agent.serverId}-${agent.id}`}
    >
      {menuActions.map((action) => {
        switch (action) {
          case "open":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_OPEN_ICON}
                onSelect={onOpen}
                testID={`sidebar-agent-view-row-open-${agent.serverId}-${agent.id}`}
              >
                {t("sidebar.agentView.menu.open")}
              </ContextMenuItem>
            );
          case "copy-reference":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_COPY_ICON}
                onSelect={handleCopyReference}
                testID={`sidebar-agent-view-row-copy-reference-${agent.serverId}-${agent.id}`}
              >
                {t("sidebar.agentView.menu.copyReference")}
              </ContextMenuItem>
            );
          case "stop":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_STOP_ICON}
                onSelect={handleStop}
                testID={`sidebar-agent-view-row-stop-${agent.serverId}-${agent.id}`}
              >
                {t("sidebar.agentView.menu.stop")}
              </ContextMenuItem>
            );
          case "mark-done":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_CIRCLE_CHECK_ICON}
                onSelect={handleMarkDone}
                testID={`sidebar-agent-view-row-mark-done-${agent.serverId}-${agent.id}`}
              >
                {t("workspace.tabs.menu.markDone")}
              </ContextMenuItem>
            );
          case "clear":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_CIRCLE_CHECK_ICON}
                onSelect={handleClear}
                testID={`sidebar-agent-view-row-clear-${agent.serverId}-${agent.id}`}
              >
                {t("sidebar.agentView.menu.clear")}
              </ContextMenuItem>
            );
          case "archive":
            return (
              <ContextMenuItem
                key={action}
                leading={MENU_ARCHIVE_ICON}
                onSelect={handleArchive}
                status={isArchiving ? "pending" : undefined}
                testID={`sidebar-agent-view-row-archive-${agent.serverId}-${agent.id}`}
              >
                {t("sidebar.agentView.menu.archive")}
              </ContextMenuItem>
            );
        }
      })}
    </ContextMenuContent>
  );
});
