import {
  useCallback,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Check,
  Copy,
  ExternalLink,
  FileDiff,
  Folder,
  GitBranch,
  Server,
} from "lucide-react-native";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { ForgeBrandIcon } from "@/git/forge-icon";
import type { Theme } from "@/styles/theme";
import { DiffStat } from "@/components/diff-stat";
import { Pressable } from "react-native";
import type { GestureResponderEvent } from "react-native";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { PrHint } from "@/git/use-pr-status-query";
import { openExternalUrl } from "@/utils/open-external-url";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { PrBadge } from "@/components/sidebar-workspace-list";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useHosts } from "@/runtime/host-runtime";
import {
  COUNTED_CHECK_PRESENTATIONS,
  countCheckPresentations,
  type CountedCheckPresentation,
} from "@/git/check-presentation";
import { formatCheckPresentationCountsLabel } from "@/git/check-presentation-copy";
import { CheckPresentationIcon, getCheckPresentationTone } from "@/git/check-presentation.view";
import { buildForgeChecksUrl } from "@/git/forge-url";
import { useSessionStore } from "@/stores/session-store";

const HOVER_CARD_WIDTH = 260;

/**
 * The workspace's project description (the description field that exists:
 * project records carry `projectDescription`; workspaces have no
 * description of their own on the wire). Resolved per (serverId, workspaceId)
 * through the session store — the hover card's only description source.
 */
function useWorkspaceProjectDescription(workspace: SidebarWorkspaceEntry): string | null {
  return useSessionStore((state) => {
    const session = state.sessions[workspace.serverId];
    if (!session) {
      return null;
    }
    const descriptor = session.workspaces.get(workspace.workspaceId);
    if (!descriptor) {
      return null;
    }
    const project = descriptor.projectId ? session.projects.get(descriptor.projectId) : null;
    return project?.projectDescription ?? null;
  });
}

interface WorkspaceHoverCardProps {
  workspace: SidebarWorkspaceEntry;
  prHint: PrHint | null;
  isDragging: boolean;
  disabled?: boolean;
}

export function WorkspaceHoverCard({
  workspace,
  prHint,
  isDragging,
  disabled = false,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactNode {
  const { t } = useTranslation();
  const content = useMemo(
    () => <WorkspaceHoverCardContent workspace={workspace} prHint={prHint} />,
    [workspace, prHint],
  );
  return (
    <SidebarRowHoverCard
      disabled={isDragging || disabled}
      accessibilityLabel={t("workspace.hoverCard.scriptsAccessibility")}
      testID="workspace-hover-card"
      content={content}
    >
      {children}
    </SidebarRowHoverCard>
  );
}

/**
 * The hover card shell every sidebar row shares: opens to the right of the row on desktop web
 * and is absent on compact layouts, where there is no hover. `content` mounts only while open.
 */
export function SidebarRowHoverCard({
  disabled,
  accessibilityLabel,
  testID,
  content,
  children,
}: PropsWithChildren<{
  disabled: boolean;
  accessibilityLabel: string;
  testID: string;
  content: ReactElement;
}>): ReactNode {
  const isCompact = useIsCompactFormFactor();

  if (isCompact) {
    return children;
  }

  return (
    <HoverCard disabled={disabled}>
      <HoverCardTrigger>{children}</HoverCardTrigger>
      <HoverCardContent
        placement="right"
        role="menu"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        style={styles.card}
      >
        {content}
      </HoverCardContent>
    </HoverCard>
  );
}

export function HoverCardHeading({
  title,
  description,
  descriptionMaxLines,
  titleTestID,
  descriptionTestID,
}: {
  title: string;
  description: string | null;
  /** Omit to show the whole description. */
  descriptionMaxLines?: number;
  titleTestID: string;
  descriptionTestID: string;
}): ReactElement {
  return (
    <>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} testID={titleTestID}>
          {title}
        </Text>
      </View>
      {description ? (
        <Text
          style={styles.cardDescription}
          numberOfLines={descriptionMaxLines}
          testID={descriptionTestID}
        >
          {description}
        </Text>
      ) : null}
    </>
  );
}

function WorkspaceHoverCardContent({
  workspace,
  prHint,
}: {
  workspace: SidebarWorkspaceEntry;
  prHint: PrHint | null;
}): ReactElement {
  const { t } = useTranslation();
  const projectDescription = useWorkspaceProjectDescription(workspace);
  return (
    <>
      <HoverCardHeading
        title={workspace.name}
        description={projectDescription}
        titleTestID="hover-card-workspace-name"
        descriptionTestID="hover-card-workspace-description"
        descriptionMaxLines={3}
      />
      {prHint ? <PrBadge hint={prHint} style={styles.cardInfoRow} /> : null}
      {workspace.diffStat ? (
        <View style={styles.cardInfoRow}>
          <ThemedFileDiff size={12} uniProps={foregroundMutedColorMapping} />
          <DiffStat
            additions={workspace.diffStat.additions}
            deletions={workspace.diffStat.deletions}
          />
        </View>
      ) : null}
      <HoverCardHostRow serverId={workspace.serverId} testID="hover-card-workspace-host" />
      {workspace.currentBranch ? (
        <HoverCardCopyableInfoRow
          icon={ThemedGitBranch}
          value={workspace.currentBranch}
          copyValue={workspace.currentBranch}
          copyLabel={t("workspace.hoverCard.copyBranchName")}
          testID="hover-card-workspace-branch"
        />
      ) : null}
      {workspace.workspaceDirectoryLabel ? (
        <HoverCardCopyableInfoRow
          icon={ThemedFolder}
          value={workspace.workspaceDirectoryLabel}
          copyValue={workspace.workspaceDirectory}
          copyLabel={t("workspace.hoverCard.copyPath")}
          testID="hover-card-workspace-cwd"
        />
      ) : null}
      {prHint?.checks && prHint.checks.length > 0 ? (
        <>
          <View style={styles.separator} />
          <ChecksSummaryPressable checks={prHint.checks} url={prHint.url} forge={prHint.forge} />
        </>
      ) : null}
    </>
  );
}

const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedFolder = withUnistyles(Folder);
const ThemedServer = withUnistyles(Server);
const ThemedFileDiff = withUnistyles(FileDiff);

export type HoverCardInfoIcon = React.ComponentType<React.ComponentProps<typeof ThemedGitBranch>>;

export function HoverCardHostRow({
  serverId,
  testID,
}: {
  serverId: string;
  testID: string;
}): ReactElement | null {
  const hosts = useHosts();
  const host = hosts.find((h) => h.serverId === serverId);
  const label = host?.label?.trim() || serverId;

  return <HoverCardInfoRow icon={ThemedServer} value={label} testID={testID} />;
}

const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function HoverCardInfoRow({
  icon: Icon,
  value,
  testID,
}: {
  icon: HoverCardInfoIcon;
  value: string;
  testID: string;
}) {
  return (
    <View style={styles.cardInfoRow}>
      <Icon size={12} uniProps={foregroundMutedColorMapping} />
      <Text style={styles.cardInfoText} numberOfLines={1} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function renderChecksSummaryForgeIcon(icon: string, iconUniProps: typeof foregroundColorMapping) {
  return <ForgeBrandIcon iconKind={icon} size={12} uniProps={iconUniProps} />;
}

export function HoverCardCopyableInfoRow({
  icon: Icon,
  value,
  copyValue,
  copyLabel,
  testID,
}: {
  icon: HoverCardInfoIcon;
  value: string;
  copyValue: string;
  copyLabel: string;
  testID: string;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePress = useCallback(() => {
    void copyToClipboard(copyValue);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  }, [copyValue]);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  let iconUniProps = foregroundMutedColorMapping;
  if (copied || isHovered) {
    iconUniProps = foregroundColorMapping;
  }
  const textStyle =
    copied || isHovered ? [styles.cardInfoText, styles.cardInfoTextHovered] : styles.cardInfoText;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copyLabel}
      style={styles.cardInfoRow}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
    >
      {(() => {
        if (copied) {
          return <ThemedCheck size={12} uniProps={iconUniProps} />;
        }
        if (isHovered) {
          return <ThemedCopy size={12} uniProps={iconUniProps} />;
        }
        return <Icon size={12} uniProps={iconUniProps} />;
      })()}
      <Text style={textStyle} numberOfLines={1} testID={testID}>
        {value}
      </Text>
    </Pressable>
  );
}

function ChecksSummaryPill({
  count,
  presentation,
}: {
  count: number;
  presentation: CountedCheckPresentation;
}) {
  if (count === 0) return null;
  return (
    <View style={styles.checksSummaryPill}>
      <CheckPresentationIcon presentation={presentation} size={12} />
      <Text style={checksSummaryTextStyle(presentation)}>{count}</Text>
    </View>
  );
}

function checksSummaryTextStyle(presentation: CountedCheckPresentation) {
  const tone = getCheckPresentationTone(presentation);
  if (tone === "success") return styles.checksStatusTextPassed;
  if (tone === "danger") return styles.checksStatusTextFailed;
  if (tone === "warning") return styles.checksStatusTextPending;
  return styles.checksStatusTextMuted;
}

function ChecksSummaryContent({
  checks,
  forge,
  hovered,
}: {
  checks: NonNullable<PrHint["checks"]>;
  forge: PrHint["forge"];
  hovered: boolean;
}) {
  const { t } = useTranslation();
  const counts = countCheckPresentations(checks);

  const labelStyle = hovered
    ? [styles.checksSummaryLabel, styles.checksSummaryLabelHovered]
    : styles.checksSummaryLabel;
  const iconUniProps = hovered ? foregroundColorMapping : foregroundMutedColorMapping;
  const icon = getForgePresentation(normalizeForge(forge)).icon;

  return (
    <>
      {hovered ? (
        <ThemedExternalLink size={12} uniProps={iconUniProps} />
      ) : (
        renderChecksSummaryForgeIcon(icon, iconUniProps)
      )}
      <Text style={labelStyle}>{t("workspace.git.pr.sections.checks")}</Text>
      <View style={styles.checksSummaryCounts}>
        {COUNTED_CHECK_PRESENTATIONS.map((presentation) => (
          <ChecksSummaryPill
            key={presentation}
            count={counts[presentation]}
            presentation={presentation}
          />
        ))}
      </View>
    </>
  );
}

function ChecksSummaryPressable({
  checks,
  forge,
  url,
}: {
  checks: NonNullable<PrHint["checks"]>;
  forge: PrHint["forge"];
  url: string;
}) {
  const { t } = useTranslation();
  const counts = countCheckPresentations(checks);
  const accessibilityLabel = formatCheckPresentationCountsLabel(
    counts,
    t("workspace.git.pr.sections.checks"),
    t,
  );
  const handlePress = useCallback(() => {
    void openExternalUrl(buildForgeChecksUrl(forge, url) ?? url);
  }, [forge, url]);

  const renderChildren = useCallback(
    ({ hovered }: { pressed: boolean; hovered?: boolean }) => (
      <ChecksSummaryContent checks={checks} forge={forge} hovered={Boolean(hovered)} />
    ),
    [checks, forge],
  );

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="link"
      style={checksSummaryPressableStyle}
      onPress={handlePress}
    >
      {renderChildren}
    </Pressable>
  );
}

function checksSummaryPressableStyle({ hovered = false }: { pressed: boolean; hovered?: boolean }) {
  return [styles.checksSummaryRow, hovered && styles.listRowHovered];
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingTop: theme.spacing[2],
    width: HOVER_CARD_WIDTH,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
    minWidth: 0,
  },
  cardDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    // Scales with the UI font size; a fixed px line height falls under the glyph height once
    // the ramp grows, and the clamped last line then bleeds into the row below.
    lineHeight: Math.round(theme.fontSize.xs * 1.35),
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardInfoText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  cardInfoTextHovered: {
    color: theme.colors.foreground,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  listRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  checksSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    minHeight: 28,
  },
  checksSummaryLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  checksSummaryLabelHovered: {
    color: theme.colors.foreground,
  },
  checksSummaryCounts: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    justifyContent: "flex-end",
  },
  checksSummaryPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  checksStatusTextFailed: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
  checksStatusTextPending: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusWarning,
  },
  checksStatusTextPassed: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
  checksStatusTextMuted: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
}));
