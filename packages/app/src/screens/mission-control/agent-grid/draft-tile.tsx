import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Folder, X } from "lucide-react-native";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { Composer } from "@/composer";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { MessagePayload } from "@/composer/types";
import { HostGlyph } from "@/components/host-glyph";
import { ProjectIconView } from "@/components/project-icon-view";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import {
  getHostProjectSourceDirectory,
  type HostProjectListItem,
  useHostProjects,
} from "@/projects/host-projects";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";
import { useProjectIcons } from "@/projects/icons";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { toErrorMessage } from "@/utils/error-messages";
import { encodeImages } from "@/utils/encode-images";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import {
  resolveNewAgentDefaults,
  type NewAgentPrefill,
  useNewAgentDefaults,
} from "./new-agent-defaults";

const ThemedX = withUnistyles(X);
const folderIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const ThemedFolder = withUnistyles(Folder, folderIconMapping);

const BADGE_HEIGHT = 28;
const PROJECT_ICON_FALLBACK_FONT_SIZE = 10;

/**
 * Renders a single project option in the Combobox popover, mirroring
 * the ProjectOptionItem pattern from new-workspace-screen.
 */
const ProjectOptionItem = memo(function ProjectOptionItem({
  testID,
  project,
  iconDataUri,
  selected,
  active,
  hostLabels,
  selectedServerId,
  onPress,
}: {
  testID: string;
  project: HostProjectListItem;
  iconDataUri: string | null;
  selected: boolean;
  active: boolean;
  hostLabels: Record<string, string>;
  selectedServerId: string | null;
  onPress: () => void;
}): ReactElement {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(project.projectName);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase() || "?";
  const sourceDirectory =
    (selectedServerId ? getHostProjectSourceDirectory(project, selectedServerId) : null) ??
    project.iconWorkingDir ??
    undefined;

  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={placeholderInitial}
          projectViewKey={project.viewKey}
          size={ICON_SIZE.md}
          textStyle={styles.projectIconFallbackText}
        />
      </View>
    ),
    [iconDataUri, placeholderInitial, project.viewKey],
  );

  const trailingSlot = useMemo(
    () =>
      project.hosts.length > 0 ? (
        <View style={styles.menuItemHosts}>
          {project.hosts.map((h) => (
            <HostGlyph
              key={h.serverId}
              serverId={h.serverId}
              label={hostLabels[h.serverId] ?? h.serverId}
              size="sm"
            />
          ))}
        </View>
      ) : undefined,
    [hostLabels, project.hosts],
  );

  return (
    <ComboboxItem
      testID={testID}
      label={project.projectName}
      description={sourceDirectory}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
    />
  );
});

export interface AgentGridDraftTileProps {
  onClose: () => void;
  prefill?: NewAgentPrefill | null;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/**
 * Draft tile rendered at index 0 of the Agent Grid.
 *
 * Compact header carries project selector bound to user defaults.
 * The draft tile never auto-closes on blur, focusout, or Escape;
 * only explicit ✕ (draft-close) or successful agent creation closes it.
 */
// eslint-disable-next-line complexity -- draft tile creation flow with prefill
export const AgentGridDraftTile = memo(function AgentGridDraftTile({
  onClose,
  prefill,
  width,
  height,
  x,
  y,
}: AgentGridDraftTileProps): ReactElement {
  const containerRef = useRef<View>(null);
  const triggerAnchorRef = useRef<View>(null);
  const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false);
  const handleToggleProjectPicker = useCallback(() => {
    setIsProjectPickerOpen((prev) => !prev);
  }, []);
  const toast = useToast();
  const { settings } = useAppSettings();
  const defaults = useNewAgentDefaults(prefill);

  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const projects = useHostProjects(allServerIds);
  const hostLabels = useMemo(
    () => Object.fromEntries(allHosts.map((h) => [h.serverId, h.label])),
    [allHosts],
  );
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    () => prefill?.serverId ?? defaults.serverId,
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(
    () => prefill?.projectKey ?? defaults.projectKey,
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => prefill?.workspaceId ?? defaults.workspaceId,
  );

  // Sync state if defaults or prefill changes initially
  useEffect(() => {
    if (prefill?.serverId) {
      setSelectedServerId(prefill.serverId);
    } else if (defaults.serverId && !selectedServerId) {
      setSelectedServerId(defaults.serverId);
    }
  }, [defaults.serverId, prefill?.serverId, selectedServerId]);

  useEffect(() => {
    if (prefill?.projectKey) {
      setSelectedProjectKey(prefill.projectKey);
    } else if (defaults.projectKey && !selectedProjectKey) {
      setSelectedProjectKey(defaults.projectKey);
    }
  }, [defaults.projectKey, prefill?.projectKey, selectedProjectKey]);

  useEffect(() => {
    if (prefill?.workspaceId) {
      setSelectedWorkspaceId(prefill.workspaceId);
    } else if (defaults.workspaceId && !selectedWorkspaceId) {
      setSelectedWorkspaceId(defaults.workspaceId);
    }
  }, [defaults.workspaceId, prefill?.workspaceId, selectedWorkspaceId]);

  const activeProject = useMemo(() => {
    if (selectedProjectKey) {
      return projects.find((p) => p.projectKey === selectedProjectKey) ?? defaults.project;
    }
    return defaults.project;
  }, [defaults.project, projects, selectedProjectKey]);

  const resolvedWorkingDir = useMemo(() => {
    if (activeProject && selectedServerId) {
      return getHostProjectSourceDirectory(activeProject, selectedServerId);
    }
    if (defaults.sourceDirectory) {
      return defaults.sourceDirectory;
    }
    return null;
  }, [activeProject, defaults.sourceDirectory, selectedServerId]);

  const draftIdRef = useRef<string>(prefill?.id ?? generateDraftId());
  const draftId = draftIdRef.current;

  const draftKey = useMemo(
    () =>
      buildDraftStoreKey({
        serverId: selectedServerId ?? "default",
        agentId: "__new_agent__",
        draftId,
      }),
    [draftId, selectedServerId],
  );

  const chatDraft = useAgentInputDraft({
    draftKey,
    composer: {
      initialServerId: selectedServerId,
      lockedWorkingDir: resolvedWorkingDir ?? undefined,
      preferenceScope: selectedProjectKey ? { projectKey: selectedProjectKey } : null,
      isVisible: true,
    },
  });

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmitMessage = useCallback(
    // eslint-disable-next-line complexity -- submit handler with payload normalization
    async (payload: MessagePayload) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      try {
        const text = payload.text.trim();
        const attachments = payload.attachments;

        const serverId = selectedServerId;
        if (!serverId) {
          throw new Error("No host selected for agent creation");
        }

        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) {
          throw new Error("Host disconnected");
        }

        const composerState = chatDraft.composerState;
        const provider = composerState?.selectedProvider;
        if (!provider) {
          throw new Error("No model provider selected");
        }

        const workingDir = resolvedWorkingDir || "";
        const config: AgentSessionConfig = buildWorkspaceDraftAgentConfig({
          provider,
          cwd: workingDir,
          modeId: composerState?.selectedMode || undefined,
          model: composerState?.effectiveModelId || undefined,
          thinkingOptionId: composerState?.effectiveThinkingOptionId || undefined,
          featureValues: composerState?.featureValues,
        });

        const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
          format: resolveComposerAttachmentSubmitFormat({
            supportsForgeAttachments: false,
          }),
        });
        const images = await encodeImages(wirePayload.images);
        const clientMessageId = `${draftId}:initial-message`;

        await client.createAgent({
          config,
          workspaceId: selectedWorkspaceId || undefined,
          initialPrompt: text.length > 0 ? text : undefined,
          clientMessageId,
          ...(images && images.length > 0 ? { images } : {}),
          ...(wirePayload.attachments && wirePayload.attachments.length > 0
            ? { attachments: wirePayload.attachments }
            : {}),
        });

        chatDraft.clear("sent");
        onClose();
      } catch (err) {
        toast.error(toErrorMessage(err));
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      chatDraft,
      draftId,
      isSubmitting,
      onClose,
      resolvedWorkingDir,
      selectedServerId,
      selectedWorkspaceId,
      toast,
    ],
  );

  const handleSelectProject = useCallback(
    (project: HostProjectListItem) => {
      const resolved = resolveNewAgentDefaults({
        settings,
        allHosts,
        projects,
        prefill: { projectKey: project.projectKey },
      });
      const nextProjectKey = resolved.projectKey ?? project.projectKey;
      const nextServerId =
        resolved.serverId ??
        (project.hosts.some((h) => h.serverId === selectedServerId)
          ? selectedServerId
          : (project.hosts[0]?.serverId ?? null));

      setSelectedProjectKey(nextProjectKey);
      setSelectedWorkspaceId(null);
      setSelectedServerId(nextServerId);
    },
    [allHosts, projects, selectedServerId, settings],
  );
  const projectIconTargets = useMemo<ProjectIconTarget[]>(() => {
    return projects.flatMap((project) => {
      let placement = selectedServerId ? null : project.hosts[0];
      if (selectedServerId) {
        for (const host of project.hosts) {
          if (host.serverId === selectedServerId) {
            placement = host;
            break;
          }
        }
        placement = placement ?? project.hosts[0];
      }
      if (!placement) return [];
      const target = createProjectIconTarget({
        projectViewKey: project.viewKey,
        placement,
      });
      return target ? [target] : [];
    });
  }, [projects, selectedServerId]);

  const projectIconDataByProjectViewKey = useProjectIcons({
    projects: projectIconTargets,
  });

  const projectByOptionId = useMemo<Record<string, HostProjectListItem>>(() => {
    const records: Record<string, HostProjectListItem> = {};
    for (const project of projects) {
      records[project.viewKey] = project;
    }
    return records;
  }, [projects]);

  const projectOptions = useMemo<ComboboxOption[]>(() => {
    return projects.map((project) => {
      const sourceDirectory =
        (selectedServerId ? getHostProjectSourceDirectory(project, selectedServerId) : null) ??
        project.iconWorkingDir ??
        undefined;
      return {
        id: project.viewKey,
        label: project.projectName,
        description: sourceDirectory,
      };
    });
  }, [projects, selectedServerId]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      const project = projectByOptionId[optionId];
      if (project) {
        handleSelectProject(project);
      }
      setIsProjectPickerOpen(false);
    },
    [handleSelectProject, projectByOptionId],
  );

  const renderProjectOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const project = projectByOptionId[option.id];
      if (!project) return <View key={option.id} />;
      return (
        <ProjectOptionItem
          key={project.viewKey}
          testID={`project-option-${project.viewKey}`}
          project={project}
          iconDataUri={projectIconDataByProjectViewKey.get(project.viewKey) ?? null}
          selected={selected}
          active={active}
          hostLabels={hostLabels}
          selectedServerId={selectedServerId}
          onPress={onPress}
        />
      );
    },
    [hostLabels, projectByOptionId, projectIconDataByProjectViewKey, selectedServerId],
  );

  const activeProjectViewKey = activeProject?.viewKey ?? null;
  const activeProjectIconDataUri = activeProjectViewKey
    ? (projectIconDataByProjectViewKey.get(activeProjectViewKey) ?? null)
    : null;

  const projectName =
    activeProject?.projectName ?? defaults.projectName ?? selectedProjectKey ?? "Select project";

  const activeProjectInitial = useMemo(() => {
    const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(projectName);
    return placeholderLabel.charAt(0).toUpperCase() || "?";
  }, [projectName]);
  const badgePressableStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.badge,
      Boolean(hovered) && styles.badgeHovered,
      Boolean(pressed) && styles.badgePressed,
    ],
    [],
  );

  const frameStyle = useMemo(() => {
    if (width !== undefined && height !== undefined && x !== undefined && y !== undefined) {
      return inlineUnistylesStyle({ left: x, top: y, width, height });
    }
    return null;
  }, [height, width, x, y]);

  return (
    <View
      ref={containerRef}
      style={[styles.tile, frameStyle]}
      testID="mission-control-agent-grid-draft"
    >
      <View style={styles.header}>
        <View style={styles.headerCluster}>
          <ComboboxTrigger
            ref={triggerAnchorRef}
            testID="mission-control-agent-grid-draft-project"
            onPress={handleToggleProjectPicker}
            style={badgePressableStyle}
            accessibilityRole="button"
            accessibilityLabel={`Select project: ${projectName}`}
          >
            <View style={styles.badgeIconBox}>
              {activeProjectViewKey ? (
                <ProjectIconView
                  iconDataUri={activeProjectIconDataUri}
                  initial={activeProjectInitial}
                  projectViewKey={activeProjectViewKey}
                  size={ICON_SIZE.md}
                  textStyle={styles.projectIconFallbackText}
                />
              ) : (
                <ThemedFolder size={12} />
              )}
            </View>
            <Text style={styles.badgeText} numberOfLines={1}>
              {projectName}
            </Text>
          </ComboboxTrigger>
          <Combobox
            options={projectOptions}
            value={activeProject?.viewKey ?? ""}
            onSelect={handleSelectOption}
            searchable
            searchPlaceholder="Search projects"
            title="Project"
            open={isProjectPickerOpen}
            onOpenChange={setIsProjectPickerOpen}
            desktopPlacement="bottom-start"
            desktopMinWidth={360}
            anchorRef={triggerAnchorRef}
            emptyText="No projects available."
            renderOption={renderProjectOption}
          />
        </View>

        <View style={styles.headerAction}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={ThemedX}
            onPress={onClose}
            accessibilityLabel="Close draft"
            testID="mission-control-agent-grid-draft-close"
          />
        </View>
      </View>

      <View style={styles.spacer} />

      <View style={styles.composerDock} testID="mission-control-agent-grid-draft-composer">
        <Composer
          key={`draft-composer-${draftId}`}
          agentId="__new_agent__"
          serverId={selectedServerId ?? ""}
          workspaceId={selectedWorkspaceId}
          isPaneFocused={true}
          onSubmitMessage={handleSubmitMessage}
          allowEmptySubmit={false}
          submitIcon="return"
          isSubmitLoading={isSubmitting}
          textSource={chatDraft.textSource}
          onChangeText={chatDraft.editText}
          textReplacement={chatDraft.textReplacement}
          attachments={chatDraft.attachments}
          onChangeAttachments={chatDraft.setAttachments}
          cwd={resolvedWorkingDir ?? ""}
          clearDraft={chatDraft.clear}
          autoFocus={true}
          autoFocusKey={draftId}
          commandDraftConfig={chatDraft.composerState?.commandDraftConfig}
          agentControls={chatDraft.composerState?.agentControls}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  tile: {
    position: "absolute",
    overflow: "hidden",
    flexDirection: "column",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    zIndex: 2,
    overflow: "hidden",
  },
  headerCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  headerAction: {
    flexShrink: 0,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    height: BADGE_HEIGHT,
    maxWidth: 240,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  badgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  badgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  badgeDisabled: {
    opacity: 0.6,
  },
  badgeText: {
    minWidth: 0,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  badgeIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectIconFallbackText: {
    fontSize: PROJECT_ICON_FALLBACK_FONT_SIZE,
    fontWeight: "600",
  },
  rowIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  spacer: {
    flex: 1,
    minHeight: 0,
  },
  composerDock: {
    width: "100%",
    position: "relative",
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  menuItemHosts: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
