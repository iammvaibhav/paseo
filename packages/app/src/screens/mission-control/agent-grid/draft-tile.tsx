import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Folder, X } from "lucide-react-native";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { Composer } from "@/composer";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { MessagePayload } from "@/composer/types";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import {
  getHostProjectSourceDirectory,
  type HostProjectListItem,
  useHostProjects,
} from "@/projects/host-projects";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { toErrorMessage } from "@/utils/error-messages";
import { encodeImages } from "@/utils/encode-images";
import { type NewAgentPrefill, useNewAgentDefaults } from "./new-agent-defaults";

const ThemedX = withUnistyles(X);
const ThemedFolder = withUnistyles(Folder);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ProjectMenuItem = memo(function ProjectMenuItem({
  project,
  onSelect,
}: {
  project: HostProjectListItem;
  onSelect: (p: HostProjectListItem) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(project), [onSelect, project]);
  return (
    <DropdownMenuItem onSelect={handleSelect}>
      <Text style={styles.menuItemText}>{project.projectName}</Text>
    </DropdownMenuItem>
  );
});

const HostMenuItem = memo(function HostMenuItem({
  host,
  onSelect,
}: {
  host: { serverId: string; label: string };
  onSelect: (serverId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(host.serverId), [host.serverId, onSelect]);
  return (
    <DropdownMenuItem onSelect={handleSelect}>
      <HostGlyph serverId={host.serverId} label={host.label} size="sm" />
      <Text style={styles.menuItemText}>{host.label}</Text>
    </DropdownMenuItem>
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
 * Compact header carries project and host selectors bound to user defaults,
 * with an Escape key or empty-unfocus dismiss behavior. Enter triggers agent
 * creation via the existing client.createAgent path with prefill workspaceId/projectKey support.
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
  const toast = useToast();
  const defaults = useNewAgentDefaults(prefill);

  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const projects = useHostProjects(allServerIds);

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
    if (defaults.sourceDirectory) {
      return defaults.sourceDirectory;
    }
    if (activeProject && selectedServerId) {
      return getHostProjectSourceDirectory(activeProject, selectedServerId);
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
  const isMenuOpenRef = useRef(false);
  const handleMenuOpenChange = useCallback((open: boolean) => {
    isMenuOpenRef.current = open;
  }, []);

  // Dismiss on Escape key (web capture phase)
  useEffect(() => {
    if (!isWeb) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  // Empty-unfocus dismiss (web focusout check)
  useEffect(() => {
    if (!isWeb) return;
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container || typeof container.addEventListener !== "function") return;

    const handleFocusOut = (event: FocusEvent) => {
      if (isMenuOpenRef.current) {
        return;
      }
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && container.contains(nextTarget)) {
        return;
      }
      const text = chatDraft.textSource.getSnapshot().trim();
      const hasAttachments = chatDraft.attachments.length > 0;
      if (!text && !hasAttachments) {
        onClose();
      }
    };

    container.addEventListener("focusout", handleFocusOut);
    return () => {
      container.removeEventListener("focusout", handleFocusOut);
    };
  }, [chatDraft.attachments.length, chatDraft.textSource, onClose]);

  // Fallback onBlur for non-web environments
  const handleBlur = useCallback(() => {
    if (isWeb) return;
    if (isMenuOpenRef.current) return;
    const text = chatDraft.textSource.getSnapshot().trim();
    const hasAttachments = chatDraft.attachments.length > 0;
    if (!text && !hasAttachments) {
      onClose();
    }
  }, [chatDraft.attachments.length, chatDraft.textSource, onClose]);

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
          format: resolveComposerAttachmentSubmitFormat({ supportsForgeAttachments: false }),
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
      setSelectedProjectKey(project.projectKey);
      setSelectedWorkspaceId(null);
      if (selectedServerId && !project.hosts.some((h) => h.serverId === selectedServerId)) {
        setSelectedServerId(project.hosts[0]?.serverId ?? null);
      }
    },
    [selectedServerId],
  );

  const frameStyle = useMemo(() => {
    if (width !== undefined && height !== undefined && x !== undefined && y !== undefined) {
      return inlineUnistylesStyle({ left: x, top: y, width, height });
    }
    return null;
  }, [height, width, x, y]);

  const projectName =
    activeProject?.projectName ?? defaults.projectName ?? selectedProjectKey ?? "Select project";

  const selectedHost = allHosts.find((h) => h.serverId === selectedServerId) ?? allHosts[0];

  return (
    <View
      ref={containerRef}
      style={[styles.tile, frameStyle]}
      testID="mission-control-agent-grid-draft"
      onBlur={handleBlur}
    >
      <View style={styles.header}>
        <View style={styles.headerCluster}>
          <DropdownMenu onOpenChange={handleMenuOpenChange}>
            <DropdownMenuTrigger
              style={styles.projectTrigger}
              accessibilityRole="button"
              accessibilityLabel={`Select project: ${projectName}`}
              testID="mission-control-agent-grid-draft-project"
            >
              <ThemedFolder size={12} />
              <Text style={styles.projectLabel} numberOfLines={1}>
                {projectName}
              </Text>
              <ThemedChevronDown size={10} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom">
              {projects.map((p) => (
                <ProjectMenuItem key={p.viewKey} project={p} onSelect={handleSelectProject} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {allHosts.length > 1 ? (
            <DropdownMenu onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger
                style={styles.hostTrigger}
                accessibilityRole="button"
                accessibilityLabel={`Select host: ${selectedHost?.label ?? selectedServerId ?? ""}`}
              >
                <HostGlyph
                  serverId={selectedServerId ?? ""}
                  label={selectedHost?.label ?? selectedServerId ?? ""}
                  size="sm"
                />
                <ThemedChevronDown size={10} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom">
                {allHosts.map((h) => (
                  <HostMenuItem key={h.serverId} host={h} onSelect={setSelectedServerId} />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <HostGlyph
              serverId={selectedServerId ?? ""}
              label={selectedHost?.label ?? selectedServerId ?? ""}
              size="sm"
            />
          )}
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

      <View style={styles.body} testID="mission-control-agent-grid-draft-composer">
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
  projectTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface1,
    maxWidth: 200,
  },
  projectLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  hostTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  body: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  menuItemText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
