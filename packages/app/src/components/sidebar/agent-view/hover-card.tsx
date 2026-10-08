import { useMemo, type PropsWithChildren, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Folder, FolderGit2 } from "lucide-react-native";
import {
  HoverCardCopyableInfoRow,
  HoverCardHeading,
  HoverCardHostRow,
  HoverCardInfoRow,
  SidebarRowHoverCard,
} from "@/components/workspace-hover-card";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { shortenPath } from "@/utils/shorten-path";

const ThemedFolder = withUnistyles(Folder);
const ThemedFolderGit2 = withUnistyles(FolderGit2);

/** The sidebar agent row's hover card: the same card a workspace row opens, about the agent. */
export function SidebarAgentHoverCard({
  agent,
  title,
  disabled,
  children,
}: PropsWithChildren<{
  agent: AggregatedAgent;
  title: string;
  disabled: boolean;
}>): ReactNode {
  const content = useMemo(
    () => <SidebarAgentHoverCardContent agent={agent} title={title} />,
    [agent, title],
  );
  return (
    <SidebarRowHoverCard
      disabled={disabled}
      accessibilityLabel={title}
      testID="sidebar-agent-hover-card"
      content={content}
    >
      {children}
    </SidebarRowHoverCard>
  );
}

function SidebarAgentHoverCardContent({
  agent,
  title,
}: {
  agent: AggregatedAgent;
  title: string;
}): ReactElement {
  const { t } = useTranslation();
  // Selects a string so the card only re-renders when the label itself changes.
  const workspaceLabel = useSessionStore((state) => {
    if (!agent.workspaceId) return null;
    const workspace = state.sessions[agent.serverId]?.workspaces.get(agent.workspaceId);
    if (!workspace) return null;
    return workspace.title?.trim() || workspace.name;
  });

  return (
    <>
      <HoverCardHeading
        title={title}
        description={agent.shortDescription ?? null}
        titleTestID="hover-card-agent-title"
        descriptionTestID="hover-card-agent-description"
      />
      <HoverCardHostRow serverId={agent.serverId} testID="hover-card-agent-host" />
      {workspaceLabel ? (
        <HoverCardInfoRow
          icon={ThemedFolderGit2}
          value={workspaceLabel}
          testID="hover-card-agent-workspace"
        />
      ) : null}
      {agent.cwd ? (
        <HoverCardCopyableInfoRow
          icon={ThemedFolder}
          value={shortenPath(agent.cwd)}
          copyValue={agent.cwd}
          copyLabel={t("workspace.hoverCard.copyPath")}
          testID="hover-card-agent-cwd"
        />
      ) : null}
    </>
  );
}
