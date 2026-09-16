import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Folder, HardDrive, LayoutGrid } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import {
  buildMoveAgentTabMessages,
  describeMoveAgentTabResult,
  moveAgentTabToExistingWorkspace,
  moveAgentTabToNewWorkspace,
  sessionFromStore,
} from "@/workspace-tabs/move-agent-tab";

const selectedIconMapping = (theme: Theme) => ({ color: theme.colors.accent });
const unselectedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedFolder = withUnistyles(Folder);
const ThemedHardDrive = withUnistyles(HardDrive);
const ThemedLayoutGrid = withUnistyles(LayoutGrid);
const ThemedCheck = withUnistyles(Check);

export interface MoveAgentModalProps {
  visible: boolean;
  onClose: () => void;
  agentId: string;
  tabId: string;
  sourceServerId: string;
  sourceWorkspaceId: string;
}

interface ProjectOption {
  projectId: string;
  displayName: string;
  rootPath: string;
}

interface WorkspaceOption {
  id: string;
  name: string;
  projectId: string;
  directory: string;
}

interface HostOption {
  serverId: string;
  name: string;
}

function HostChip({
  option,
  selected,
  onSelect,
}: {
  option: HostOption;
  selected: boolean;
  onSelect: (serverId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.serverId), [onSelect, option.serverId]);
  return (
    <Pressable
      testID={`move-target-host-${option.serverId}`}
      style={[styles.chip, selected ? styles.chipSelected : null]}
      onPress={handlePress}
    >
      <ThemedHardDrive
        size={14}
        uniProps={selected ? selectedIconMapping : unselectedIconMapping}
      />
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
        {option.name}
      </Text>
    </Pressable>
  );
}

function ProjectChip({
  option,
  selected,
  onSelect,
}: {
  option: ProjectOption;
  selected: boolean;
  onSelect: (projectId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.projectId), [onSelect, option.projectId]);
  return (
    <Pressable
      testID={`move-target-project-${option.projectId}`}
      style={[styles.chip, selected ? styles.chipSelected : null]}
      onPress={handlePress}
    >
      <ThemedLayoutGrid
        size={14}
        uniProps={selected ? selectedIconMapping : unselectedIconMapping}
      />
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
        {option.displayName}
      </Text>
    </Pressable>
  );
}

function WorkspaceRow({
  option,
  selected,
  isCurrent,
  onSelect,
}: {
  option: WorkspaceOption;
  selected: boolean;
  isCurrent: boolean;
  onSelect: (workspaceId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  return (
    <Pressable
      testID={`move-target-workspace-${option.id}`}
      style={[styles.optionItem, selected ? styles.optionItemSelected : null]}
      onPress={handlePress}
    >
      <View style={styles.optionIconCol}>
        <ThemedFolder size={18} uniProps={selected ? selectedIconMapping : unselectedIconMapping} />
      </View>
      <View style={styles.optionDetails}>
        <Text style={[styles.optionTitle, selected ? styles.optionTitleSelected : null]}>
          {option.name}
          {isCurrent ? <Text style={styles.currentBadge}> (Current)</Text> : null}
        </Text>
        <Text style={styles.optionSubtitle} numberOfLines={1}>
          {option.directory}
        </Text>
      </View>
      {selected ? (
        <View style={styles.checkIcon}>
          <ThemedCheck size={16} uniProps={selectedIconMapping} />
        </View>
      ) : null}
    </Pressable>
  );
}

function NewWorkspaceRow({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: (workspaceId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect("new"), [onSelect]);
  return (
    <Pressable
      testID="move-target-new-workspace"
      style={[
        styles.optionItem,
        styles.newWorkspaceOption,
        selected ? styles.optionItemSelected : null,
      ]}
      onPress={handlePress}
    >
      <Text style={[styles.newWorkspaceText, selected ? styles.optionTitleSelected : null]}>
        + Create new workspace in this project
      </Text>
      {selected ? (
        <View style={styles.checkIcon}>
          <ThemedCheck size={16} uniProps={selectedIconMapping} />
        </View>
      ) : null}
    </Pressable>
  );
}

const MoveAgentFooter = memo(function MoveAgentFooter({
  isSubmitting,
  canSubmit,
  onClose,
  onSubmit,
}: {
  isSubmitting: boolean;
  canSubmit: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <View style={styles.footerRow}>
      <Button testID="move-agent-cancel" variant="ghost" onPress={onClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button testID="move-agent-submit" variant="default" disabled={!canSubmit} onPress={onSubmit}>
        {isSubmitting ? "Moving..." : "Move"}
      </Button>
    </View>
  );
});

function resolveTitle(targetProjectName: string | null | undefined, sourceName?: string | null) {
  if (targetProjectName) return `${targetProjectName} (new)`;
  if (sourceName) return `${sourceName} (2)`;
  return undefined;
}

export function MoveAgentModal({
  visible,
  onClose,
  agentId,
  tabId,
  sourceServerId,
  sourceWorkspaceId,
}: MoveAgentModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const sessions = useSessionStore((state) => state.sessions);
  const registeredHosts = useHosts();

  const [selectedServerId, setSelectedServerId] = useState(sourceServerId);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const header = useMemo<SheetHeader>(() => ({ title: "Move Agent" }), []);

  const availableHosts = useMemo(() => {
    const map = new Map<string, { serverId: string; name: string }>();
    for (const host of registeredHosts) {
      map.set(host.serverId, { serverId: host.serverId, name: host.label });
    }
    for (const serverId of Object.keys(sessions)) {
      if (!map.has(serverId)) {
        map.set(serverId, { serverId, name: serverId === sourceServerId ? "Local" : serverId });
      }
    }
    return Array.from(map.values());
  }, [registeredHosts, sessions, sourceServerId]);

  const currentTargetSession = sessions[selectedServerId];

  const availableProjects = useMemo<ProjectOption[]>(() => {
    if (!currentTargetSession) return [];
    const projectsMap = new Map<string, ProjectOption>();

    if (currentTargetSession.projects) {
      for (const [id, p] of currentTargetSession.projects.entries()) {
        projectsMap.set(id, {
          projectId: id,
          displayName: p.projectCustomName ?? p.projectDisplayName ?? id,
          rootPath: p.projectRootPath,
        });
      }
    }

    if (currentTargetSession.workspaces) {
      for (const ws of currentTargetSession.workspaces.values()) {
        if (ws.projectId && !projectsMap.has(ws.projectId)) {
          projectsMap.set(ws.projectId, {
            projectId: ws.projectId,
            displayName: ws.projectCustomName ?? ws.projectDisplayName ?? ws.projectId,
            rootPath: ws.projectRootPath ?? ws.workspaceDirectory,
          });
        }
      }
    }

    return Array.from(projectsMap.values());
  }, [currentTargetSession]);

  const availableWorkspaces = useMemo<WorkspaceOption[]>(() => {
    if (!currentTargetSession?.workspaces) return [];
    const list: WorkspaceOption[] = [];
    for (const ws of currentTargetSession.workspaces.values()) {
      if (ws.archivingAt) continue;
      if (selectedProjectId && ws.projectId !== selectedProjectId) continue;
      list.push({
        id: ws.id,
        name: ws.title ?? ws.name ?? ws.id,
        projectId: ws.projectId,
        directory: ws.workspaceDirectory,
      });
    }
    return list;
  }, [currentTargetSession, selectedProjectId]);

  useEffect(() => {
    if (!visible) {
      setIsSubmitting(false);
      return;
    }

    setSelectedServerId(sourceServerId);

    const sourceSession = sessions[sourceServerId];
    const sourceWs = sourceSession?.workspaces.get(sourceWorkspaceId);
    setSelectedProjectId(sourceWs?.projectId ?? null);

    if (sourceSession?.workspaces) {
      const other = Array.from(sourceSession.workspaces.values()).find(
        (w) => w.id !== sourceWorkspaceId && !w.archivingAt,
      );
      setSelectedWorkspaceId(other?.id ?? null);
    } else {
      setSelectedWorkspaceId(null);
    }
    setIsSubmitting(false);
  }, [visible, sourceServerId, sourceWorkspaceId, sessions]);

  const selectServer = useCallback(
    (serverId: string) => {
      setSelectedServerId(serverId);
      const session = sessions[serverId];
      const firstProj = session?.projects ? Array.from(session.projects.keys())[0] : null;
      setSelectedProjectId(firstProj ?? null);
      setSelectedWorkspaceId(null);
    },
    [sessions],
  );

  const selectProject = useCallback(
    (projectId: string) => {
      setSelectedProjectId(projectId);
      const session = sessions[selectedServerId];
      const match = Array.from(session?.workspaces.values() ?? []).find(
        (w) => w.projectId === projectId && !w.archivingAt && w.id !== sourceWorkspaceId,
      );
      setSelectedWorkspaceId(match?.id ?? null);
    },
    [selectedServerId, sessions, sourceWorkspaceId],
  );

  const selectWorkspace = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
  }, []);

  const isSameLocation =
    selectedServerId === sourceServerId && selectedWorkspaceId === sourceWorkspaceId;

  const canSubmit = Boolean(selectedWorkspaceId) && !isSameLocation && !isSubmitting;

  const handleMove = useCallback(async () => {
    if (!selectedWorkspaceId || isSameLocation || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const sourceSession = sessions[sourceServerId];
      if (selectedWorkspaceId === "new") {
        const targetSession = sessions[selectedServerId];
        const targetProj = selectedProjectId
          ? targetSession?.projects?.get(selectedProjectId)
          : null;
        const result = await moveAgentTabToNewWorkspace({
          session: sessionFromStore(sourceSession),
          layout: useWorkspaceLayoutStore.getState(),
          navigation: { navigateToWorkspace },
          messages: buildMoveAgentTabMessages(t),
          serverId: sourceServerId,
          sourceWorkspaceId,
          agentId,
          tabId,
          targetServerId: selectedServerId,
          targetProjectId: selectedProjectId ?? undefined,
          targetDirectory: targetProj?.projectRootPath,
          targetProjectName: targetProj?.projectCustomName ?? targetProj?.projectDisplayName,
        });
        const described = describeMoveAgentTabResult(result, {
          existing: t("workspace.tabs.toasts.movedToWorkspace", { workspaceName: "" }),
          created: t("workspace.tabs.toasts.movedToNewWorkspace"),
        });
        if (described.kind === "error") {
          toast.error(described.message);
        } else {
          toast.show(described.message, { variant: "success" });
          onClose();
        }
      } else {
        const result = await moveAgentTabToExistingWorkspace({
          session: sessionFromStore(sourceSession),
          layout: useWorkspaceLayoutStore.getState(),
          navigation: { navigateToWorkspace },
          messages: buildMoveAgentTabMessages(t),
          serverId: sourceServerId,
          sourceWorkspaceId,
          targetWorkspaceId: selectedWorkspaceId,
          targetServerId: selectedServerId,
          agentId,
          tabId,
        });
        const targetSession = sessions[selectedServerId];
        const targetWorkspaceName = targetSession?.workspaces.get(selectedWorkspaceId)?.name ?? "";
        const described = describeMoveAgentTabResult(result, {
          existing: t("workspace.tabs.toasts.movedToWorkspace", {
            workspaceName: targetWorkspaceName,
          }),
          created: t("workspace.tabs.toasts.movedToNewWorkspace"),
        });
        if (described.kind === "error") {
          toast.error(described.message);
        } else {
          toast.show(described.message, { variant: "success" });
          onClose();
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to move agent");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    agentId,
    isSameLocation,
    isSubmitting,
    onClose,
    selectedProjectId,
    selectedServerId,
    selectedWorkspaceId,
    sessions,
    sourceServerId,
    sourceWorkspaceId,
    t,
    tabId,
    toast,
  ]);

  useEffect(() => {
    if (!visible) {
      setIsSubmitting(false);
      return;
    }

    setSelectedServerId(sourceServerId);

    const sourceSession = sessions[sourceServerId];
    const sourceWs = sourceSession?.workspaces.get(sourceWorkspaceId);
    setSelectedProjectId(sourceWs?.projectId ?? null);

    // No pre-selected workspace: the user must pick an explicit target so an
    // accidental confirm can never move the agent somewhere unintended.
    setSelectedWorkspaceId(null);
    setIsSubmitting(false);
  }, [visible, sourceServerId, sourceWorkspaceId, sessions]);

  const handleSubmit = useCallback(() => {
    void handleMove();
  }, [handleMove]);

  const footer = useMemo(
    () => (
      <MoveAgentFooter
        isSubmitting={isSubmitting}
        canSubmit={canSubmit}
        onClose={onClose}
        onSubmit={handleSubmit}
      />
    ),
    [isSubmitting, canSubmit, onClose, handleSubmit],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="move-agent-modal"
      footer={footer}
    >
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {availableHosts.length > 1 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Target Host</Text>
            <View style={styles.chipRow}>
              {availableHosts.map((h) => (
                <HostChip
                  key={h.serverId}
                  option={h}
                  selected={h.serverId === selectedServerId}
                  onSelect={selectServer}
                />
              ))}
            </View>
          </View>
        ) : null}

        {availableProjects.length > 1 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Target Project</Text>
            <View style={styles.chipRow}>
              {availableProjects.map((p) => (
                <ProjectChip
                  key={p.projectId}
                  option={p}
                  selected={p.projectId === selectedProjectId}
                  onSelect={selectProject}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Target Workspace</Text>
          <View style={styles.optionsList}>
            {availableWorkspaces.map((ws) => (
              <WorkspaceRow
                key={ws.id}
                option={ws}
                selected={ws.id === selectedWorkspaceId}
                isCurrent={selectedServerId === sourceServerId && ws.id === sourceWorkspaceId}
                onSelect={selectWorkspace}
              />
            ))}

            <NewWorkspaceRow selected={selectedWorkspaceId === "new"} onSelect={selectWorkspace} />
          </View>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

export { resolveTitle };

const styles = StyleSheet.create((theme) => ({
  content: {
    maxHeight: 400,
  },
  contentInner: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 16,
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  chipSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    fontSize: 13,
    color: theme.colors.foreground,
  },
  chipTextSelected: {
    fontWeight: "600",
    color: theme.colors.accent,
  },
  optionsList: {
    gap: 6,
  },
  optionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    gap: 10,
  },
  optionItemSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  optionIconCol: {
    justifyContent: "center",
  },
  optionDetails: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  optionTitleSelected: {
    color: theme.colors.accent,
  },
  currentBadge: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  optionSubtitle: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  checkIcon: {
    marginLeft: "auto",
  },
  newWorkspaceOption: {
    borderStyle: "dashed",
  },
  newWorkspaceText: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
    paddingVertical: 2,
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
  },
}));
