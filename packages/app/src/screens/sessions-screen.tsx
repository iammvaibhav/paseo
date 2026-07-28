import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { View, Text, TextInput, ActivityIndicator } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { HostProfile } from "@/types/host-connection";
import {
  filterByHistoryAskFuzzy,
  isHistoryAskAgent,
  launchHistoryAsk,
  resolveHostScope,
  useHistoryAskStore,
  type HistoryAskScope,
  type HistoryAskTab,
} from "@/history-ask";

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

function SessionsScreenContent() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const history = useAgentHistory({ serverId: historyServerId });

  const activeTab = useHistoryAskStore((state) => state.activeTab);
  const setActiveTab = useHistoryAskStore((state) => state.setActiveTab);
  const pendingScope = useHistoryAskStore((state) => state.pendingScope);
  const clearPending = useHistoryAskStore((state) => state.clearPending);

  const [searchQuery, setSearchQuery] = useState("");
  const [isManualRefresh, setIsManualRefresh] = useState(false);

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  useEffect(() => {
    if (pendingScope?.serverId) {
      setSelectedHost(pendingScope.serverId);
    }
  }, [pendingScope?.serverId]);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void history.refreshAll().finally(() => setIsManualRefresh(false));
  }, [history]);

  const sortedAgents = useMemo(() => {
    return [...history.agents].sort(
      (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
    );
  }, [history.agents]);

  const filteredAgents = useMemo(
    () => filterByHistoryAskFuzzy(sortedAgents, searchQuery),
    [sortedAgents, searchQuery],
  );

  const askAgents = useMemo(
    () => sortedAgents.filter((agent) => isHistoryAskAgent(agent.labels)),
    [sortedAgents],
  );

  const resolvedAskScope = useMemo(
    () => resolveAskScope({ pendingScope, selectedHost, hosts }),
    [pendingScope, selectedHost, hosts],
  );

  const showHostFilter = hosts.length > 1;
  const showLoadError = history.isError && sortedAgents.length === 0;

  const tabOptions = useMemo(
    () => [
      {
        value: "agents" as const,
        label: t("sessions.tabs.agents"),
        testID: "sessions-tab-agents",
      },
      {
        value: "ask" as const,
        label: t("sessions.tabs.ask"),
        testID: "sessions-tab-ask",
      },
    ],
    [t],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={setSelectedHost}
              triggerTestID="sessions-host-filter-trigger"
            />
          ) : null}
          <SegmentedControl
            size="sm"
            value={activeTab}
            onValueChange={setActiveTab}
            options={tabOptions}
            testID="sessions-tab-control"
          />
        </View>
        {activeTab === "agents" ? (
          <TextInput
            testID="sessions-search-input"
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t("sessions.search.placeholder")}
            placeholderTextColor={styles.placeholderColor.color}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        ) : null}
      </View>

      {activeTab === "agents" ? (
        <SessionsAgentsTab
          isInitialLoad={history.isInitialLoad}
          showLoadError={showLoadError}
          agents={filteredAgents}
          searchQuery={searchQuery}
          selectedHost={selectedHost}
          isManualRefresh={isManualRefresh}
          hasMore={history.hasMore}
          isLoadingMore={history.isLoadingMore}
          onRefresh={handleRefresh}
          onLoadMore={history.loadMore}
        />
      ) : (
        <SessionsAskTab
          scope={resolvedAskScope}
          agents={askAgents}
          isInitialLoad={history.isInitialLoad}
          isManualRefresh={isManualRefresh}
          hasMore={history.hasMore}
          isLoadingMore={history.isLoadingMore}
          onRefresh={handleRefresh}
          onLoadMore={history.loadMore}
          onLaunched={clearPending}
          refreshAll={history.refreshAll}
        />
      )}
    </View>
  );
}

function SessionsAgentsTab(input: {
  isInitialLoad: boolean;
  showLoadError: boolean;
  agents: AggregatedAgent[];
  searchQuery: string;
  selectedHost: string;
  isManualRefresh: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const emptyText =
    input.selectedHost === ALL_HOSTS_OPTION_ID ? t("sessions.empty") : t("sessions.emptyForHost");

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const listFooterComponent = useMemo(
    () =>
      input.hasMore ? (
        <View style={styles.footer}>
          <Button variant="ghost" onPress={input.onLoadMore} disabled={input.isLoadingMore}>
            {input.isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
          </Button>
        </View>
      ) : null,
    [input.hasMore, input.onLoadMore, input.isLoadingMore, t],
  );

  if (input.isInitialLoad) {
    return (
      <View style={styles.loadingContainer}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (input.showLoadError) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{t("sessions.loadError")}</Text>
        <Button variant="ghost" onPress={input.onRefresh}>
          {t("sessions.actions.tryAgain")}
        </Button>
      </View>
    );
  }

  if (input.agents.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {input.searchQuery.trim() ? t("sessions.search.empty") : emptyText}
        </Text>
        {!input.searchQuery.trim() ? (
          <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
            {t("sessions.actions.back")}
          </Button>
        ) : null}
      </View>
    );
  }

  return (
    <AgentList
      agents={input.agents}
      showCheckoutInfo={false}
      isRefreshing={input.isManualRefresh}
      onRefresh={input.onRefresh}
      listFooterComponent={listFooterComponent}
      showAttentionIndicator={false}
      showHostColumn
    />
  );
}

function SessionsAskTab({
  scope,
  agents,
  isInitialLoad,
  isManualRefresh,
  hasMore,
  isLoadingMore,
  onRefresh,
  onLoadMore,
  onLaunched,
  refreshAll,
}: {
  scope: HistoryAskScope | null;
  agents: AggregatedAgent[];
  isInitialLoad: boolean;
  isManualRefresh: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
  onLaunched: () => void;
  refreshAll: () => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const [askQuestion, setAskQuestion] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);

  const handleAskSubmit = useCallback(async () => {
    const question = askQuestion.trim();
    if (!question || isLaunching) {
      return;
    }
    if (!scope) {
      toast.error(t("sessions.ask.errors.noScope"));
      return;
    }

    const client = getHostRuntimeStore().getClient(scope.serverId);
    if (!client) {
      toast.error(t("sessions.ask.errors.hostDisconnected"));
      return;
    }

    const primaryCwd = scope.cwds[0] ?? firstWorkspaceCwdOnHost(scope.serverId) ?? null;

    setIsLaunching(true);
    try {
      await launchHistoryAsk({
        client,
        scope,
        question,
        primaryCwd,
      });
      setAskQuestion("");
      onLaunched();
      toast.show(t("sessions.ask.launched"), { variant: "success" });
      void refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessions.ask.errors.launchFailed"));
    } finally {
      setIsLaunching(false);
    }
  }, [askQuestion, isLaunching, scope, toast, t, onLaunched, refreshAll]);

  const handleAskPress = useCallback(() => {
    void handleAskSubmit();
  }, [handleAskSubmit]);

  const canSubmit = Boolean(askQuestion.trim() && !isLaunching && scope);

  const listFooterComponent = useMemo(
    () =>
      hasMore ? (
        <View style={styles.footer}>
          <Button variant="ghost" onPress={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
          </Button>
        </View>
      ) : null,
    [hasMore, onLoadMore, isLoadingMore, t],
  );

  return (
    <View style={styles.askContainer}>
      <View style={styles.askComposer}>
        <View style={styles.scopeChip} testID="sessions-ask-scope-chip">
          <Text style={styles.scopeChipLabel}>{t("sessions.ask.scopeLabel")}</Text>
          <Text style={styles.scopeChipValue} numberOfLines={1}>
            {formatScopeChip(scope, t)}
          </Text>
        </View>
        <TextInput
          testID="sessions-ask-input"
          value={askQuestion}
          onChangeText={setAskQuestion}
          placeholder={t("sessions.ask.placeholder")}
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.askInput}
          multiline
          textAlignVertical="top"
          editable={!isLaunching}
        />
        <Button testID="sessions-ask-submit" onPress={handleAskPress} disabled={!canSubmit}>
          {isLaunching ? (
            <ActivityIndicator color={styles.submitSpinner.color} />
          ) : (
            t("sessions.ask.submit")
          )}
        </Button>
      </View>

      <Text style={styles.askJobsHeading}>{t("sessions.ask.jobsHeading")}</Text>
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : null}
      {!isInitialLoad && agents.length === 0 ? (
        <View style={styles.askEmpty}>
          <Text style={styles.emptyText}>{t("sessions.ask.empty")}</Text>
        </View>
      ) : null}
      {!isInitialLoad && agents.length > 0 ? (
        <AgentList
          agents={agents}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={onRefresh}
          listFooterComponent={listFooterComponent}
          showAttentionIndicator={false}
          showHostColumn
        />
      ) : null}
    </View>
  );
}

function resolveAskScope(input: {
  pendingScope: HistoryAskScope | null;
  selectedHost: string;
  hosts: HostProfile[];
}): HistoryAskScope | null {
  if (input.pendingScope) {
    return input.pendingScope;
  }

  if (input.selectedHost !== ALL_HOSTS_OPTION_ID) {
    const host = input.hosts.find((entry) => entry.serverId === input.selectedHost);
    return resolveHostScope({
      serverId: input.selectedHost,
      displayName: host?.label ?? input.selectedHost,
    });
  }

  const first = input.hosts[0];
  if (!first) {
    return null;
  }
  return resolveHostScope({
    serverId: first.serverId,
    displayName: first.label,
  });
}

function firstWorkspaceCwdOnHost(serverId: string): string | null {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) {
    return null;
  }
  for (const workspace of session.workspaces.values()) {
    if (workspace.status === "done") {
      continue;
    }
    const cwd = workspace.workspaceDirectory?.trim();
    if (cwd) {
      return cwd;
    }
  }
  return null;
}

function formatScopeChip(
  scope: HistoryAskScope | null,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (!scope) {
    return t("sessions.ask.scopeUnknown");
  }
  switch (scope.kind) {
    case "workspace":
      return t("sessions.ask.scopeWorkspace", { name: scope.displayName });
    case "project":
      return t("sessions.ask.scopeProject", { name: scope.displayName });
    case "host":
      return t("sessions.ask.scopeHost", { name: scope.displayName });
  }
}

// HistoryAskTab kept for store typing consumers of this screen.
export type { HistoryAskTab };

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    gap: theme.spacing[3],
  },
  toolbarRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  searchInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  submitSpinner: {
    color: theme.colors.surface0,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  askContainer: {
    flex: 1,
    paddingTop: theme.spacing[3],
  },
  askComposer: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  scopeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  scopeChipLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
  scopeChipValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    maxWidth: 280,
  },
  askInput: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
  },
  askJobsHeading: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingBottom: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  askEmpty: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
}));
