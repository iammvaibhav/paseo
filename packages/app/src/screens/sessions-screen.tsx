import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { View, Text, TextInput, ActivityIndicator } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentSearchMatch } from "@getpaseo/protocol/messages";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { SearchField } from "@/components/ui/search-field";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Field } from "@/components/ui/form-field";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { ModelProviderGlyph } from "@/components/model-browser";
import { type AgentHistoryHostError, useAgentHistory } from "@/hooks/use-agent-history";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { HostProfile } from "@/types/host-connection";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import {
  isHistoryAskAgent,
  launchHistoryAsk,
  resolveHistoryAskLaunchCwd,
  resolveHostScope,
  useHistoryAskStore,
  type HistoryAskScope,
  type HistoryAskTab,
} from "@/history-ask";
import { useHistoryAskModelSelection } from "@/history-ask/use-history-ask-model-selection";
import { openAgentFromHistory } from "@/workspace/open-agent-from-history";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

const sessionsHostOptionTestID = (serverId: string) => `sessions-host-filter-item-${serverId}`;

/**
 * A host that failed while others answered. Without this the list silently
 * under-reports, and under a query "No sessions match" becomes a claim the app
 * has no basis for.
 */
function SessionHostErrorsBanner({
  errors,
  t,
}: {
  errors: AgentHistoryHostError[];
  t: TFunction;
}): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="sessions-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {t("sessions.hostLoadFailed", { host: error.serverName })}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** An empty list means something different once a query is narrowing it. */
function resolveEmptyText(input: {
  t: TFunction;
  isSearching: boolean;
  isAllHosts: boolean;
}): string {
  if (input.isSearching) return input.t("sessions.noMatches");
  if (input.isAllHosts) return input.t("sessions.empty");
  return input.t("sessions.emptyForHost");
}

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
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;

  const activeTab = useHistoryAskStore((state) => state.activeTab);
  const setActiveTab = useHistoryAskStore((state) => state.setActiveTab);
  const pendingScope = useHistoryAskStore((state) => state.pendingScope);
  const clearPending = useHistoryAskStore((state) => state.clearPending);

  // Server-side history search applies only on the Agents tab. Ask needs the
  // unfiltered host history for job listing and launch cwd resolution.
  const historySearch = activeTab === "agents" ? search : "";
  const {
    agents,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    isSearchSupported,
    isSearchTruncated,
    searchMatchesByAgentKey,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({
    serverId: historyServerId,
    search: historySearch,
  });
  const isSearching = isSearchSupported && historySearch.length > 0;

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
    } else if (activeTab === "ask" && selectedHost === ALL_HOSTS_OPTION_ID && hosts.length > 0) {
      setSelectedHost(hosts[0].serverId);
    }
  }, [activeTab, pendingScope?.serverId, selectedHost, hosts]);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const handleClearSearch = useCallback(() => setSearchInput(""), []);

  // `useAgentHistory` owns the order: recency at rest, relevance under a query.
  const askAgents = useMemo(
    () => agents.filter((agent) => isHistoryAskAgent(agent.labels)),
    [agents],
  );

  // Pending project/workspace scope wins until cleared. Host-wide Ask requires a
  // concrete host: "All hosts" cannot launch (one agent process per host).
  const resolvedAskScope = useMemo(
    () =>
      resolveAskScope({
        pendingScope,
        selectedHost,
        hosts,
        requireConcreteHost: false,
      }),
    [pendingScope, selectedHost, hosts],
  );

  const needsHostSelection =
    activeTab === "ask" &&
    !pendingScope &&
    selectedHost === ALL_HOSTS_OPTION_ID &&
    hosts.length === 0;

  const showHostFilter = hosts.length > 1;
  const showLoadError = isError && agents.length === 0;

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
              hostOptionTestID={sessionsHostOptionTestID}
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
        {activeTab === "agents" && isSearchSupported ? (
          <SearchField
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder={t("sessions.searchPlaceholder")}
            clearAccessibilityLabel={t("sessions.actions.clearSearch")}
            testID="sessions-search-input"
            clearTestID="sessions-search-clear"
          />
        ) : null}
      </View>

      {hostErrors.length > 0 && activeTab === "agents" ? (
        <SessionHostErrorsBanner errors={hostErrors} t={t} />
      ) : null}

      {activeTab === "agents" ? (
        <SessionsAgentsTab
          isInitialLoad={isInitialLoad}
          showLoadError={showLoadError}
          agents={agents}
          isSearching={isSearching}
          selectedHost={selectedHost}
          isManualRefresh={isManualRefresh}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          isSearchTruncated={isSearchTruncated}
          searchMatchesByAgentKey={isSearching ? searchMatchesByAgentKey : undefined}
          onRefresh={handleRefresh}
          onLoadMore={loadMore}
          onClearSearch={handleClearSearch}
        />
      ) : (
        <SessionsAskTab
          scope={resolvedAskScope}
          needsHostSelection={needsHostSelection}
          historyAgents={agents}
          askAgents={askAgents}
          isInitialLoad={isInitialLoad}
          isManualRefresh={isManualRefresh}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onRefresh={handleRefresh}
          onLoadMore={loadMore}
          onLaunched={clearPending}
          refreshAll={refreshAll}
        />
      )}
    </View>
  );
}

function SessionsAgentsTab(input: {
  isInitialLoad: boolean;
  showLoadError: boolean;
  agents: AggregatedAgent[];
  isSearching: boolean;
  selectedHost: string;
  isManualRefresh: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  isSearchTruncated: boolean;
  searchMatchesByAgentKey?: Record<string, AgentSearchMatch[]>;
  onRefresh: () => void;
  onLoadMore: () => void;
  onClearSearch: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const emptyText = resolveEmptyText({
    t,
    isSearching: input.isSearching,
    isAllHosts: input.selectedHost === ALL_HOSTS_OPTION_ID,
  });

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const listFooterComponent = useMemo(() => {
    // A ranked result set has no next page — reaching a weaker match means
    // narrowing the query, so the footer says that instead of offering a button.
    if (input.isSearchTruncated) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerHint}>{t("sessions.tooManyMatches")}</Text>
        </View>
      );
    }
    if (!input.hasMore) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button variant="ghost" onPress={input.onLoadMore} disabled={input.isLoadingMore}>
          {input.isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
        </Button>
      </View>
    );
  }, [input.hasMore, input.isLoadingMore, input.isSearchTruncated, input.onLoadMore, t]);

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
      <View style={styles.emptyContainer} testID="sessions-empty">
        <Text style={styles.emptyText}>{emptyText}</Text>
        {input.isSearching ? (
          <Button variant="ghost" onPress={input.onClearSearch}>
            {t("sessions.actions.clearSearch")}
          </Button>
        ) : (
          <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
            {t("sessions.actions.back")}
          </Button>
        )}
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
      searchMatchesByAgentKey={input.searchMatchesByAgentKey}
      flat={input.isSearching}
    />
  );
}

function SessionsAskTab({
  scope,
  needsHostSelection,
  historyAgents,
  askAgents,
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
  needsHostSelection: boolean;
  historyAgents: AggregatedAgent[];
  askAgents: AggregatedAgent[];
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

  // Launch cwd is internal only (createAgent requires a directory). Host-wide
  // History Ask does not show or offer cwd selection — search scope is the host.
  const resolveLaunchCwd = useCallback(() => {
    if (!scope) {
      return null;
    }
    return resolveHistoryAskLaunchCwd({
      scope,
      workspaceCwds: listWorkspaceCwdsOnHost(scope.serverId),
      historyAgentCwds: listHistoryAgentCwdsOnHost(scope.serverId, historyAgents),
    });
  }, [scope, historyAgents]);

  const snapshotCwd = useMemo(() => resolveLaunchCwd(), [resolveLaunchCwd]);
  const modelSelection = useHistoryAskModelSelection({
    scope,
    needsHostSelection,
    snapshotCwd,
  });

  const modelTriggerLeading = useMemo(() => {
    if (!modelSelection.selectedProvider) {
      return null;
    }
    return <ModelProviderGlyph provider={modelSelection.selectedProvider} size={14} />;
  }, [modelSelection.selectedProvider]);

  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => (
      <SelectFieldTrigger
        label={selectedModelLabel}
        isPlaceholder={!modelSelection.selectedModel}
        placeholder={t("sessions.ask.modelPlaceholder")}
        leading={modelTriggerLeading}
        disabled={disabled}
        active={hovered || pressed || isOpen}
        size="md"
        testID="sessions-ask-model-trigger"
      />
    ),
    [modelSelection.selectedModel, modelTriggerLeading, t],
  );

  const handleAskSubmit = useCallback(async () => {
    const question = askQuestion.trim();
    if (!question || isLaunching) {
      return;
    }
    if (needsHostSelection || !scope) {
      toast.error(t("sessions.ask.errors.noScope"));
      return;
    }

    const client = getHostRuntimeStore().getClient(scope.serverId);
    if (!client) {
      toast.error(t("sessions.ask.errors.hostDisconnected"));
      return;
    }

    const primaryCwd = resolveLaunchCwd();
    if (!primaryCwd) {
      toast.error(t("sessions.ask.errors.noCwd"));
      return;
    }

    setIsLaunching(true);
    try {
      modelSelection.persistCurrentSelection();
      const result = await launchHistoryAsk({
        client,
        scope,
        question,
        primaryCwd,
        provider: modelSelection.selectedProvider || null,
        model: modelSelection.selectedModel || null,
      });
      setAskQuestion("");
      onLaunched();
      // First-class: open the Ask agent immediately (same path as History row click).
      void openAgentFromHistory({
        serverId: result.serverId,
        agentId: result.agentId,
        archived: false,
      });
      toast.show(t("sessions.ask.launched"), { variant: "success" });
      void refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessions.ask.errors.launchFailed"));
    } finally {
      setIsLaunching(false);
    }
  }, [
    askQuestion,
    isLaunching,
    needsHostSelection,
    scope,
    resolveLaunchCwd,
    modelSelection,
    toast,
    t,
    onLaunched,
    refreshAll,
  ]);

  const handleAskPress = useCallback(() => {
    void handleAskSubmit();
  }, [handleAskSubmit]);

  const canSubmit = Boolean(askQuestion.trim() && !isLaunching && scope && !needsHostSelection);

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
            {needsHostSelection ? t("sessions.ask.scopeSelectHost") : formatScopeChip(scope, t)}
          </Text>
        </View>
        {needsHostSelection ? (
          <Text style={styles.askHint} testID="sessions-ask-need-host">
            {t("sessions.ask.needHostHint")}
          </Text>
        ) : null}
        {!needsHostSelection && scope ? (
          <HistoryAskModelField
            providers={modelSelection.modelSelectorProviders}
            selectedProvider={modelSelection.selectedProvider}
            selectedModel={modelSelection.selectedModel}
            onSelect={modelSelection.handleSelectModel}
            isLoading={modelSelection.isLoading}
            renderTrigger={renderModelTrigger}
            serverId={modelSelection.serverId}
            disabled={isLaunching}
            onOpen={modelSelection.handleModelOpen}
            onRetryProvider={modelSelection.handleRetryProvider}
            isRetrying={modelSelection.isRetrying}
          />
        ) : null}
        <TextInput
          testID="sessions-ask-input"
          value={askQuestion}
          onChangeText={setAskQuestion}
          placeholder={t("sessions.ask.placeholder")}
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.askInput}
          multiline
          textAlignVertical="top"
          editable={!isLaunching && !needsHostSelection}
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
      <Text style={styles.askHint}>{t("sessions.ask.jobsOpenHint")}</Text>
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : null}
      {!isInitialLoad && askAgents.length === 0 ? (
        <View style={styles.askEmpty}>
          <Text style={styles.emptyText}>{t("sessions.ask.empty")}</Text>
        </View>
      ) : null}
      {!isInitialLoad && askAgents.length > 0 ? (
        <AgentList
          agents={askAgents}
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

function HistoryAskModelField(input: {
  providers: ReturnType<typeof buildSelectableProviderSelectorProviders>;
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  renderTrigger: (args: {
    selectedModelLabel: string;
    onPress: () => void;
    disabled: boolean;
    isOpen: boolean;
    hovered: boolean;
    pressed: boolean;
  }) => ReactNode;
  serverId: string | null;
  disabled: boolean;
  onOpen: () => void;
  onRetryProvider: (provider: AgentProvider) => void;
  isRetrying: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Field label={t("sessions.ask.modelLabel")} testID="sessions-ask-model-field">
      <CombinedModelSelector
        providers={input.providers}
        selectedProvider={input.selectedProvider}
        selectedModel={input.selectedModel}
        onSelect={input.onSelect}
        isLoading={input.isLoading}
        renderTrigger={input.renderTrigger}
        triggerFill
        serverId={input.serverId}
        disabled={input.disabled}
        onOpen={input.onOpen}
        onRetryProvider={input.onRetryProvider}
        isRetryingProvider={input.isRetrying}
      />
    </Field>
  );
}

function resolveAskScope(input: {
  pendingScope: HistoryAskScope | null;
  selectedHost: string;
  hosts: HostProfile[];
  /** When true, "All hosts" does not silently pick the first host. */
  requireConcreteHost?: boolean;
}): HistoryAskScope | null {
  // Project/workspace entry points stamp pending scope — keep it even if the
  // host filter is still on All hosts (we also align the filter to that host).
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

  // Single connected host: All hosts ≡ that host.
  if (input.hosts.length === 1) {
    const only = input.hosts[0];
    if (!only) {
      return null;
    }
    return resolveHostScope({
      serverId: only.serverId,
      displayName: only.label,
    });
  }

  if (input.requireConcreteHost) {
    return null;
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

function listWorkspaceCwdsOnHost(serverId: string): string[] {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) {
    return [];
  }
  const active: string[] = [];
  const archived: string[] = [];
  for (const workspace of session.workspaces.values()) {
    const cwd = workspace.workspaceDirectory?.trim();
    if (!cwd) {
      continue;
    }
    if (workspace.status === "done") {
      archived.push(cwd);
    } else {
      active.push(cwd);
    }
  }
  return active.length > 0 ? active : archived;
}

function listHistoryAgentCwdsOnHost(
  serverId: string,
  agents: readonly AggregatedAgent[],
): string[] {
  const cwds: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (agent.serverId !== serverId) {
      continue;
    }
    const cwd = agent.cwd?.trim();
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    cwds.push(cwd);
  }
  return cwds;
}

function formatScopeChip(
  scope: HistoryAskScope | null,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (!scope) {
    return t("sessions.ask.scopeSelectHost");
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
  footerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBannerWrap: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[3],
  },
  errorsBanner: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
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
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foreground,
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
  askHint: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingBottom: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
