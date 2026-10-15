import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Archive, Search } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHistoryAskStore } from "@/history-ask/history-ask-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarSearchStore } from "@/stores/sidebar-search-store";
import type { Theme } from "@/styles/theme";
import { buildSessionsRoute } from "@/utils/host-routes";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { SidebarArchivedAgentRow } from "./agent-view/row";
import { SidebarAgentViewSectionHeader } from "./agent-view/section-header";
import { menuTriggerStyles } from "./display-preferences/filter-pages";
import { useSidebarModel } from "./sidebar-model";
import type { SidebarSearchArchivedMatch } from "./sidebar-search";

const ThemedSearch = withUnistyles(Search);
const ThemedArchive = withUnistyles(Archive);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/** Header icon that opens the search bar (and closes it again). */
export function SidebarSearchToggle(): ReactElement {
  const { t } = useTranslation();
  const isOpen = useSidebarSearchStore((state) => state.isOpen);
  const open = useSidebarSearchStore((state) => state.open);
  const close = useSidebarSearchStore((state) => state.close);
  const style = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      menuTriggerStyles.trigger,
      (hovered || isOpen) && menuTriggerStyles.triggerHovered,
    ],
    [isOpen],
  );
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);
  return (
    <Pressable
      style={style}
      onPress={isOpen ? close : open}
      accessibilityRole="button"
      accessibilityLabel={isOpen ? t("sidebar.search.close") : t("sidebar.search.open")}
      accessibilityState={accessibilityState}
      testID="sidebar-search-toggle"
    >
      <ThemedSearch size={14} uniProps={isOpen ? foregroundIconMapping : mutedIconMapping} />
    </Pressable>
  );
}

/** Closes the mobile sidebar overlay before navigating; a no-op on desktop. */
function useCloseCompactSidebar(): () => void {
  const isCompact = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  return useCallback(() => {
    if (isCompact) showMobileAgent();
  }, [isCompact, showMobileAgent]);
}

/**
 * The open search bar: the query narrows the list below it in place, and
 * archived matches (opt-in) are listed here because the list never shows them.
 * Opening one unarchives it with its workspace and project.
 */
export function SidebarSearchPanel(): ReactElement | null {
  const { t } = useTranslation();
  const isOpen = useSidebarSearchStore((state) => state.isOpen);
  const query = useSidebarSearchStore((state) => state.query);
  const includeArchived = useSidebarSearchStore((state) => state.includeArchived);
  const setQuery = useSidebarSearchStore((state) => state.setQuery);
  const setIncludeArchived = useSidebarSearchStore((state) => state.setIncludeArchived);
  const close = useSidebarSearchStore((state) => state.close);
  const { search } = useSidebarModel();
  const closeCompactSidebar = useCloseCompactSidebar();

  const toggleArchived = useCallback(
    () => setIncludeArchived(!includeArchived),
    [includeArchived, setIncludeArchived],
  );
  const openArchived = useCallback(
    (match: SidebarSearchArchivedMatch) => {
      closeCompactSidebar();
      void openAgentFromHistory({
        serverId: match.serverId,
        agentId: match.agentId,
        archived: true,
      });
    },
    [closeCompactSidebar],
  );
  const archivedChipState = useMemo(() => ({ checked: includeArchived }), [includeArchived]);

  if (!isOpen) return null;

  const status = search.pending ? t("sidebar.search.searching") : null;

  return (
    <View style={styles.panel} testID="sidebar-search-panel">
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t("sidebar.search.placeholder")}
        clearAccessibilityLabel={t("sidebar.search.clear")}
        testID="sidebar-search-input"
        clearTestID="sidebar-search-clear"
        autoFocus
        onEscape={close}
      />
      <View style={styles.optionsRow}>
        <Pressable
          onPress={toggleArchived}
          accessibilityRole="switch"
          accessibilityState={archivedChipState}
          style={[styles.chip, includeArchived && styles.chipActive]}
          testID="sidebar-search-include-archived"
        >
          <ThemedArchive
            size={12}
            uniProps={includeArchived ? foregroundIconMapping : mutedIconMapping}
          />
          <Text style={[styles.chipText, includeArchived && styles.chipTextActive]}>
            {t("sidebar.search.includeArchived")}
          </Text>
        </Pressable>
        {status ? (
          <Text style={styles.status} numberOfLines={1} testID="sidebar-search-status">
            {status}
          </Text>
        ) : null}
      </View>
      {includeArchived && search.archivedMatches.length > 0 ? (
        <View style={styles.archived} testID="sidebar-search-archived">
          <SidebarAgentViewSectionHeader
            title={t("sidebar.search.archivedTitle")}
            count={search.archivedMatches.length}
            testID="sidebar-search-archived-section"
          />
          {search.archivedMatches.map((match) => (
            <ArchivedMatchRow
              key={`${match.serverId}:${match.agentId}`}
              match={match}
              onPress={openArchived}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ArchivedMatchRow({
  match,
  onPress,
}: {
  match: SidebarSearchArchivedMatch;
  onPress: (match: SidebarSearchArchivedMatch) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(match), [match, onPress]);
  return (
    <SidebarArchivedAgentRow
      agentId={match.agentId}
      title={match.title ?? match.name ?? t("agentList.fallbackTitle")}
      lastActivityAt={match.lastActivityAt}
      onPress={handlePress}
    />
  );
}

/** List body when a search matched nothing: the way out is the deep, agentic search. */
export function SidebarSearchEmptyState(): ReactElement | null {
  const { t } = useTranslation();
  const query = useSidebarSearchStore((state) => state.query.trim());
  const close = useSidebarSearchStore((state) => state.close);
  const askAboutSearch = useHistoryAskStore((state) => state.askAboutSearch);
  const closeCompactSidebar = useCloseCompactSidebar();
  const { search } = useSidebarModel();
  const deepSearch = useCallback(() => {
    askAboutSearch(query);
    closeCompactSidebar();
    router.navigate(buildSessionsRoute());
  }, [askAboutSearch, closeCompactSidebar, query]);

  // Word matches came up empty but a host may still answer; the bar says Searching….
  // Archived matches are listed under the bar, so the list is not empty-handed.
  if (search.pending || search.archivedMatches.length > 0) return null;

  return (
    <View style={styles.empty} testID="sidebar-search-empty-state">
      <Text style={styles.emptyTitle}>{t("sidebar.search.emptyTitle")}</Text>
      <Text style={styles.emptyDescription}>{t("sidebar.search.emptyDescription")}</Text>
      <View style={styles.emptyActions}>
        <Button variant="secondary" size="xs" onPress={deepSearch} testID="sidebar-search-deep">
          {t("sidebar.search.deepSearch")}
        </Button>
        <Button variant="ghost" size="xs" onPress={close}>
          {t("sidebar.search.clear")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1.5],
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  chipActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    borderColor: theme.colors.borderAccent,
  },
  chipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  chipTextActive: {
    color: theme.colors.foreground,
  },
  status: {
    flex: 1,
    minWidth: 0,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // The panel renders inside the agent list's inset and adds its own spacing[1];
  // cancelling that lines archived rows up with the rows below.
  archived: {
    marginHorizontal: -theme.spacing[1],
  },
  empty: {
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[4],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
