import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHistoryAskStore } from "@/history-ask/history-ask-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarSearchStore } from "@/stores/sidebar-search-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { buildSessionsRoute } from "@/utils/host-routes";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";
import { SidebarArchivedAgentRow } from "./agent-view/row";
import { SidebarAgentViewSectionHeader } from "./agent-view/section-header";
import { useSidebarModel } from "./sidebar-model";
import type { SidebarSearchArchivedMatch } from "./sidebar-search";

/** Closes the mobile sidebar overlay before navigating; a no-op on desktop. */
function useCloseCompactSidebar(): () => void {
  const isCompact = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  return useCallback(() => {
    if (isCompact) showMobileAgent();
  }, [isCompact, showMobileAgent]);
}

/**
 * The always-visible search bar above the sidebar list. It sits outside the
 * list's scroll view so it stays on screen while scrolling, and so it keeps
 * focus when typing switches the list to the agent view: inside the list it
 * would remount with every view or loading-state change.
 */
export function SidebarSearchBar(): ReactElement {
  const { t } = useTranslation();
  const query = useSidebarSearchStore((state) => state.query);
  const setQuery = useSidebarSearchStore((state) => state.setQuery);
  const setInputFocused = useSidebarSearchStore((state) => state.setInputFocused);
  const clear = useSidebarSearchStore((state) => state.clear);
  const viewMode = useSidebarViewStore((state) => state.viewMode);
  const setViewMode = useSidebarViewStore((state) => state.setViewMode);

  // Search is for agents: a query switches the list to the agent view.
  const handleChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      if (text.trim().length > 0 && viewMode !== "agents") setViewMode("agents");
    },
    [setQuery, setViewMode, viewMode],
  );
  const handleFocus = useCallback(() => setInputFocused(true), [setInputFocused]);
  const handleBlur = useCallback(() => setInputFocused(false), [setInputFocused]);

  return (
    <View style={styles.bar} testID="sidebar-search-bar">
      <SearchField
        value={query}
        onChangeText={handleChangeText}
        placeholder={t("sidebar.search.placeholder")}
        clearAccessibilityLabel={t("sidebar.search.clear")}
        testID="sidebar-search-input"
        clearTestID="sidebar-search-clear"
        onEscape={clear}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
    </View>
  );
}

/**
 * Archived matches of the current search, below the active results. The list
 * never shows archived agents otherwise; opening one unarchives it with its
 * workspace and project.
 */
export function SidebarSearchArchivedSection(): ReactElement | null {
  const { t } = useTranslation();
  const { search } = useSidebarModel();
  const closeCompactSidebar = useCloseCompactSidebar();
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

  if (!search.active || search.archivedMatches.length === 0) return null;

  return (
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
      serverId={match.serverId}
      agentId={match.agentId}
      workspaceId={match.workspaceId}
      title={match.title ?? match.name ?? t("agentList.fallbackTitle")}
      lastActivityAt={match.lastActivityAt}
      onPress={handlePress}
    />
  );
}

/**
 * List body when a search has nothing to list: Searching… while a host may
 * still answer, then the way out, the deep agentic search.
 */
export function SidebarSearchEmptyState(): ReactElement {
  const { t } = useTranslation();
  const query = useSidebarSearchStore((state) => state.query.trim());
  const clear = useSidebarSearchStore((state) => state.clear);
  const askAboutSearch = useHistoryAskStore((state) => state.askAboutSearch);
  const closeCompactSidebar = useCloseCompactSidebar();
  const { search } = useSidebarModel();
  const deepSearch = useCallback(() => {
    askAboutSearch(query);
    closeCompactSidebar();
    router.navigate(buildSessionsRoute());
  }, [askAboutSearch, closeCompactSidebar, query]);

  if (search.pending) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyDescription} testID="sidebar-search-status">
          {t("sidebar.search.searching")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.empty} testID="sidebar-search-empty-state">
      <Text style={styles.emptyTitle}>{t("sidebar.search.emptyTitle")}</Text>
      <Text style={styles.emptyDescription}>{t("sidebar.search.emptyDescription")}</Text>
      <View style={styles.emptyActions}>
        <Button variant="secondary" size="sm" onPress={deepSearch} testID="sidebar-search-deep">
          {t("sidebar.search.deepSearch")}
        </Button>
        <Button variant="ghost" size="sm" onPress={clear}>
          {t("sidebar.search.clear")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Lines the field up with the list's section headers below it.
  bar: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1.5],
  },
  archived: {
    paddingBottom: theme.spacing[3],
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
