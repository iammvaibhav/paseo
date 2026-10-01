/* oxlint-disable no-nested-ternary, complexity, react-perf */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { CalendarClock, Github, GitBranch, Plus, Webhook } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { WebhookFormSheet } from "@/components/webhooks/webhook-form-sheet";
import { useAutomations, type AggregatedAutomation } from "@/hooks/use-automations";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { router } from "expo-router";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { HostProfile } from "@/types/host-connection";
import type { AutomationKind } from "@getpaseo/protocol/automation/types";

interface AutomationClient {
  automationCreate: (input: {
    name: string | null;
    kind: AutomationKind;
    target: { type: "agent"; agentId: string };
    promptTemplate: string;
    poll: {
      repos: string[];
      labels: string[];
      actors: string[];
      events: string[];
      pollIntervalSec: number;
    };
  }) => Promise<unknown>;
  automationUpdate: (input: {
    automationId: string;
    name: string | null;
    target: { type: "agent"; agentId: string };
    promptTemplate: string;
    poll: {
      repos: string[];
      labels: string[];
      actors: string[];
      events: string[];
      pollIntervalSec: number;
    };
  }) => Promise<unknown>;
}

interface CreateFormState {
  mode: "create";
  kind: AutomationKind;
}
interface EditFormState {
  mode: "edit";
  automation: AggregatedAutomation;
}
type FormState = { mode: "closed" } | CreateFormState | EditFormState;

const KIND_OPTIONS: { value: AutomationKind; label: string }[] = [
  { value: "schedule", label: "Schedule" },
  { value: "webhook", label: "Webhook" },
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
];
const FILTER_OPTIONS: { value: AutomationKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  ...KIND_OPTIONS,
];

export function AutomationsScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <AutomationsScreenContent />;
}

function AutomationsScreenContent(): ReactElement {
  const { loadState, hostErrors, isError, refetch, hasSupportedHost, hasKnownHost } =
    useAutomations();
  const hosts = useHosts();
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const automations = loadState.status === "loaded" ? loadState.data : [];
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [kindFilter, setKindFilter] = useState<AutomationKind | "all">("all");
  const [form, setForm] = useState<FormState>({ mode: "closed" });

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const visible = useMemo(
    () =>
      automations.filter(
        (item) =>
          (selectedHost === ALL_HOSTS_OPTION_ID || item.serverId === selectedHost) &&
          (kindFilter === "all" || item.kind === kindFilter),
      ),
    [automations, kindFilter, selectedHost],
  );
  const closeForm = useCallback(() => setForm({ mode: "closed" }), []);
  const openCreate = useCallback(
    (kind: AutomationKind = "schedule") => setForm({ mode: "create", kind }),
    [],
  );
  const openEdit = useCallback(
    (automation: AggregatedAutomation) => setForm({ mode: "edit", automation }),
    [],
  );

  if (hasKnownHost && !hasSupportedHost) {
    return (
      <View style={styles.container}>
        <MenuHeader title="Automations" />
        <View style={styles.centered}>
          <Text style={styles.title}>Automations need an updated host</Text>
          <Text style={styles.message}>Connect to a host that supports unified automations.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Automations" />
      <View style={styles.toolbar}>
        {hosts.length > 1 ? (
          <HostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={setSelectedHost}
            triggerTestID="automations-host-filter"
          />
        ) : null}
        <SegmentedControl
          value={kindFilter}
          options={FILTER_OPTIONS}
          onValueChange={setKindFilter}
          testID="automations-kind-filter"
        />
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={() => openCreate()}
          testID="automations-new"
        >
          New automation
        </Button>
      </View>
      {loadState.status !== "loaded" ? (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.icon.color} />
        </View>
      ) : isError ? (
        <View style={styles.centered}>
          <Text style={styles.message}>Unable to load automations</Text>
          <Button variant="ghost" onPress={refetch} testID="automations-retry">
            Try again
          </Button>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} testID="automations-list">
          {hostErrors.map((error) => (
            <Text key={error.serverId} style={styles.error}>
              {error.serverName}: Could not load automations
            </Text>
          ))}
          {visible.length === 0 ? (
            <View style={styles.centered}>
              <Text style={styles.title}>No automations</Text>
              <Text style={styles.message}>Create a schedule, webhook, or event trigger.</Text>
            </View>
          ) : (
            visible.map((automation) => (
              <AutomationRow
                key={`${automation.serverId}:${automation.id}`}
                automation={automation}
                onEdit={openEdit}
              />
            ))
          )}
        </ScrollView>
      )}
      <AutomationForm
        form={form}
        hosts={hosts}
        agents={agents}
        onClose={closeForm}
        onChangeKind={(kind) => {
          if (form.mode === "create") setForm({ mode: "create", kind });
        }}
      />
    </View>
  );
}

function AutomationRow({
  automation,
  onEdit,
}: {
  automation: AggregatedAutomation;
  onEdit: (automation: AggregatedAutomation) => void;
}): ReactElement {
  const latest = automation.recentRuns[0];
  return (
    <View style={styles.row} testID={`automation-row-${automation.id}`}>
      <View style={styles.rowMain}>
        <View style={styles.rowTitle}>
          <KindIcon kind={automation.kind} />
          <Text style={styles.name}>{automation.name || `${automation.kind} automation`}</Text>
        </View>
        <Text style={styles.meta}>
          {automation.serverName} · {automation.enabled ? "Enabled" : "Paused"}
        </Text>
        <Text style={styles.template} numberOfLines={2}>
          {automation.promptTemplate}
        </Text>
        {latest ? (
          <View style={styles.run}>
            <Text
              style={styles.meta}
            >{`Last run: ${latest.status} · ${new Date(latest.startedAt).toLocaleString()}`}</Text>
            {latest.agentId ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={() =>
                  router.push(
                    buildHostAgentDetailRoute(
                      automation.serverId,
                      latest.agentId!,
                      latest.workspaceId ?? undefined,
                    ),
                  )
                }
              >
                Open agent
              </Button>
            ) : null}
          </View>
        ) : (
          <Text style={styles.meta}>No runs yet</Text>
        )}
      </View>
      <Button
        variant="ghost"
        size="sm"
        onPress={() => onEdit(automation)}
        testID={`automation-edit-${automation.id}`}
      >
        Edit
      </Button>
    </View>
  );
}

function KindIcon({ kind }: { kind: AutomationKind }): ReactElement {
  const Icon =
    kind === "schedule"
      ? CalendarClock
      : kind === "webhook"
        ? Webhook
        : kind === "github"
          ? Github
          : GitBranch;
  return <Icon size={16} color={styles.icon.color} />;
}

function AutomationForm({
  form,
  hosts,
  agents,
  onClose,
  onChangeKind,
}: {
  form: FormState;
  hosts: HostProfile[];
  agents: AggregatedAgent[];
  onClose: () => void;
  onChangeKind: (kind: AutomationKind) => void;
}): ReactElement | null {
  if (form.mode === "closed") return null;
  const kind = form.mode === "edit" ? form.automation.kind : form.kind;
  if (kind === "schedule") {
    return (
      <ScheduleFormSheet
        key={`${form.mode}:schedule`}
        visible
        serverId={form.mode === "edit" ? form.automation.serverId : undefined}
        mode="create"
        onClose={onClose}
      />
    );
  }
  if (kind === "webhook") {
    return (
      <WebhookFormSheet
        key={`${form.mode}:webhook`}
        visible
        serverId={form.mode === "edit" ? form.automation.serverId : undefined}
        mode="create"
        onClose={onClose}
      />
    );
  }
  return (
    <PollAutomationSheet
      form={form}
      hosts={hosts}
      agents={agents}
      onClose={onClose}
      onChangeKind={onChangeKind}
    />
  );
}

function PollAutomationSheet({
  form,
  hosts,
  agents,
  onClose,
  onChangeKind,
}: {
  form: CreateFormState | EditFormState;
  hosts: HostProfile[];
  agents: AggregatedAgent[];
  onClose: () => void;
  onChangeKind: (kind: AutomationKind) => void;
}): ReactElement {
  const existing = form.mode === "edit" ? form.automation : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [template, setTemplate] = useState(
    existing?.promptTemplate ?? "Handle this event: {{event.title}}",
  );
  const [repos, setRepos] = useState(existing?.poll?.repos.join(", ") ?? "");
  const [labels, setLabels] = useState(existing?.poll?.labels.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const serverId = existing?.serverId ?? hosts[0]?.serverId;
  const targetAgent = agents.find((agent) => agent.serverId === serverId);
  const header: SheetHeader = { title: existing ? "Edit automation" : "New automation" };

  const save = async () => {
    if (!serverId || !targetAgent || !template.trim()) return;
    setBusy(true);
    try {
      const client = getHostRuntimeStore().getClient(serverId) as
        | AutomationClient
        | null
        | undefined;
      if (!client) return;
      const target = { type: "agent", agentId: targetAgent.id } as const;
      const provider = form.mode === "create" ? form.kind : existing?.kind;
      const poll = {
        repos: splitList(repos),
        labels: splitList(labels),
        actors: [],
        events: existing?.poll?.events ?? [
          provider === "linear" ? "issue_created" : "issue_opened",
        ],
        pollIntervalSec: 300,
      };
      if (existing) {
        await client.automationUpdate({
          automationId: existing.id,
          name: name.trim() || null,
          target,
          promptTemplate: template.trim(),
          poll,
        });
      } else if (form.mode === "create") {
        await client.automationCreate({
          name: name.trim() || null,
          kind: form.kind,
          target,
          promptTemplate: template.trim(),
          poll,
        });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdaptiveModalSheet visible header={header} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.form}>
        {!existing ? (
          <SegmentedControl
            value={form.mode === "create" ? form.kind : "github"}
            options={KIND_OPTIONS}
            onValueChange={onChangeKind}
            testID="automation-trigger-kind"
          />
        ) : null}
        <Field label="Name">
          <FormTextInput
            initialValue={name}
            onChangeText={setName}
            size="sm"
            testID="automation-name"
          />
        </Field>
        <Field label="Prompt template">
          <FormTextInput
            initialValue={template}
            onChangeText={setTemplate}
            size="sm"
            multiline
            testID="automation-prompt"
          />
        </Field>
        <Field label={providerLabel(form)}>
          <FormTextInput
            initialValue={repos}
            onChangeText={setRepos}
            size="sm"
            placeholder="owner/repo, another/repo"
            testID="automation-repos"
          />
        </Field>
        {form.mode === "create" && form.kind === "github" ? (
          <Field label="Labels">
            <FormTextInput
              initialValue={labels}
              onChangeText={setLabels}
              size="sm"
              placeholder="bug, urgent"
              testID="automation-labels"
            />
          </Field>
        ) : null}
        {!targetAgent ? (
          <Text style={styles.error}>
            Create an agent on this host before adding an event trigger.
          </Text>
        ) : null}
        <Button
          variant="default"
          onPress={() => void save()}
          loading={busy}
          disabled={!targetAgent || !template.trim()}
          testID="automation-save"
        >
          Save automation
        </Button>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function providerLabel(form: CreateFormState | EditFormState): string {
  return (form.mode === "create" ? form.kind : form.automation.kind) === "github"
    ? "Repositories"
    : "Teams";
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    flexWrap: "wrap",
  },
  list: { padding: theme.spacing[4], gap: theme.spacing[3] },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  rowMain: { flex: 1, gap: theme.spacing[1] },
  rowTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  name: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" },
  meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
  template: { color: theme.colors.foreground, fontSize: 13 },
  run: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  icon: { color: theme.colors.foregroundMuted },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600", textAlign: "center" },
  message: { color: theme.colors.foregroundMuted, textAlign: "center" },
  error: { color: theme.colors.destructive, paddingHorizontal: theme.spacing[4] },
  form: { padding: theme.spacing[4], gap: theme.spacing[3] },
}));
