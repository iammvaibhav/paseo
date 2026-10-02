import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Plus, Webhook } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { ExternalLink } from "@/components/ui/external-link";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { WebhookFormSheet } from "@/components/webhooks/webhook-form-sheet";
import { WebhooksTable, type WebhookRowView } from "@/components/webhooks/webhooks-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  useWebhooks,
  type AggregateLoadState,
  type AggregatedWebhook,
  type WebhookHostError,
} from "@/hooks/use-webhooks";
import { useHosts } from "@/runtime/host-runtime";
import { resolveWebhookTarget, type WebhookTargetAgent } from "@/webhooks/webhook-derivation";
import { resolveWebhooksScreenBodyState } from "./webhooks-screen-state";
import {
  buildProjectNameByCwd,
  buildScheduleProjectTargets,
} from "@/schedules/schedule-project-targets";
import type { WebhookSummary } from "@getpaseo/protocol/webhook/types";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; serverId: string; webhook: WebhookSummary };

const EMPTY_WEBHOOKS: AggregatedWebhook[] = [];

export function WebhooksScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <WebhooksScreenContent />;
}

function WebhooksScreenContent(): ReactElement {
  const { loadState, hostErrors, isError, refetch } = useWebhooks();
  const webhooks = loadState.status === "loaded" ? loadState.data : EMPTY_WEBHOOKS;
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const { projects } = useProjects();
  const hosts = useHosts();

  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const openCreate = useCallback(() => setForm({ mode: "create" }), []);
  const openEdit = useCallback((webhook: AggregatedWebhook) => {
    setForm({ mode: "edit", serverId: webhook.serverId, webhook });
  }, []);
  const closeForm = useCallback(() => setForm({ mode: "closed" }), []);

  const agentsByKey = useMemo(() => {
    const map = new Map<string, WebhookTargetAgent>();
    for (const agent of agents) {
      map.set(`${agent.serverId}:${agent.id}`, { title: agent.title, provider: agent.provider });
    }
    return map;
  }, [agents]);

  const projectNameByCwd = useMemo(
    () => buildProjectNameByCwd(buildScheduleProjectTargets(projects)),
    [projects],
  );

  // Resolve every webhook's target line once, then partition by the host filter.
  // Sorted newest-first for a stable order across hosts.
  const visibleRows = useMemo<WebhookRowView[]>(() => {
    const singleHost = hosts.length <= 1;
    return webhooks
      .filter(
        (webhook) => selectedHost === ALL_HOSTS_OPTION_ID || webhook.serverId === selectedHost,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((webhook) => {
        const target = resolveWebhookTarget({
          webhook,
          serverId: webhook.serverId,
          agentsByKey,
          projectNameByCwd,
        });
        return {
          webhook,
          targetLabel: target.label,
          provider: target.provider,
          serverName: webhook.serverName,
          singleHost,
        };
      });
  }, [webhooks, selectedHost, hosts.length, agentsByKey, projectNameByCwd]);

  const showLoadError = isError && loadState.status !== "loaded";
  const showHostFilter = hosts.length > 1;

  return (
    <View style={styles.container}>
      <MenuHeader title="Webhooks" />
      <WebhooksScreenBody
        rows={visibleRows}
        loadState={loadState}
        hostErrors={hostErrors}
        showLoadError={showLoadError}
        showHostFilter={showHostFilter}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        onRetry={refetch}
        onCreate={openCreate}
        onEdit={openEdit}
      />
      <WebhookFormSheet
        serverId={form.mode === "edit" ? form.serverId : undefined}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        webhook={form.mode === "edit" ? form.webhook : undefined}
      />
    </View>
  );
}

function WebhooksScreenBody({
  rows,
  loadState,
  hostErrors,
  showLoadError,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  onCreate,
  onEdit,
}: {
  rows: WebhookRowView[];
  loadState: AggregateLoadState<AggregatedWebhook>;
  hostErrors: WebhookHostError[];
  showLoadError: boolean;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (webhook: AggregatedWebhook) => void;
}): ReactElement {
  const bodyState = resolveWebhooksScreenBodyState({ loadState, showLoadError });

  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Unable to load webhooks</Text>
        <Button variant="ghost" onPress={onRetry} testID="webhooks-retry">
          Try again
        </Button>
      </View>
    );
  }

  if (bodyState.kind === "empty") {
    return (
      <View style={styles.centered}>
        {hostErrors.length > 0 ? <WebhookHostErrorsBanner errors={hostErrors} /> : null}
        <WebhooksEmptyState onCreate={onCreate} testID="webhooks-empty" />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.filterRow}>
        <View style={styles.filterRowControls}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
              triggerTestID="webhooks-host-filter-trigger"
            />
          ) : null}
        </View>
        <Button
          variant="outline"
          leftIcon={Plus}
          onPress={onCreate}
          size="sm"
          testID="webhooks-new"
        >
          New webhook
        </Button>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="webhooks-list"
      >
        {hostErrors.length > 0 ? <WebhookHostErrorsBanner errors={hostErrors} /> : null}
        <WebhooksTable rows={rows} onEditWebhook={onEdit} />
      </ScrollView>
    </View>
  );
}

function WebhooksEmptyState({
  onCreate,
  testID,
}: {
  onCreate: () => void;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.emptyState} testID={testID}>
      <Webhook size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <View style={styles.emptyTextStack}>
        <Text style={styles.emptyTitle}>No webhooks</Text>
        <Text style={styles.emptyDescription}>
          Webhooks run agents when an HTTP request hits their URL.
        </Text>
        <ExternalLink href="https://paseo.sh/docs/webhooks" label="See docs" />
      </View>
      <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="webhooks-empty-new">
        New webhook
      </Button>
    </View>
  );
}

function WebhookHostErrorsBanner({ errors }: { errors: WebhookHostError[] }): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="webhooks-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {`${error.serverName}: Could not load webhooks`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  filterRowControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
    flexWrap: "wrap",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  errorsBannerWrap: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  emptyTextStack: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
}));
