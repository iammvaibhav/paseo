import type { OwnedSubscription } from "@getpaseo/client";
import type { Query, QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ListTerminalsResponse,
  MutableDaemonConfig,
  SessionEventSubscription,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { agentCommandsQueryRoot } from "@/hooks/agent-commands-query";
import { shareCheckoutDiff } from "@/git/diff-sharing";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { missionControlEventsQueryKey } from "@/data/mission-control-events";
import { missionControlInstructionsQueryKey } from "@/data/mission-control-instructions";
import { type ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import {
  normalizeProvidersSnapshotCwd,
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
} from "@/data/providers-snapshot";
import { providerUsageQueryKey } from "@/provider-usage/query-key";
import { ticketsQueryRoot } from "@/tickets/query-keys";
import { notesQueryRoot } from "@/notes/query-keys";

type ProvidersSnapshotUpdateMessage = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>;
type SubscribeCheckoutDiffResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "subscribe_checkout_diff_response" }
>;
type StatusMessage = Extract<SessionOutboundMessage, { type: "status" }>;
type TerminalsChangedMessage = Extract<SessionOutboundMessage, { type: "terminals_changed" }>;

type CheckoutDiffResponsePayload = SubscribeCheckoutDiffResponseMessage["payload"];
type CheckoutDiffCachePayload = Omit<CheckoutDiffResponsePayload, "subscriptionId">;
type ListTerminalsPayload = ListTerminalsResponse["payload"];

interface CheckoutDiffCompare {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
}

interface CheckoutDiffRoute {
  domain: "checkoutDiff";
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}

interface CheckoutDiffRegistration extends CheckoutDiffRoute {
  subscription: OwnedSubscription<CheckoutDiffResponsePayload>;
}

interface WorkspaceTerminalsRoute {
  domain: "workspaceTerminals";
  enabled: boolean;
  serverId: string;
  cwd: string;
  workspaceId?: string;
}

interface WorkspaceTerminalsRegistration extends WorkspaceTerminalsRoute {
  subscription: OwnedSubscription<TerminalsChangedMessage["payload"]>;
}

type EventStreamDomain = "notes" | "tickets" | "missionControlEvents" | "providerUsage";

/** A query that needs one connection event stream held while it is observed. */
interface EventStreamRoute {
  domain: EventStreamDomain;
  enabled: boolean;
  serverId: string;
}

type ServerDataRoute = CheckoutDiffRoute | WorkspaceTerminalsRoute | EventStreamRoute;

// COMPAT(fastProviderUsage): stable identity for one usage card across full and
// per-provider pushes. Matches the daemon's providerCardKey in
// packages/server/src/services/quota-fetcher/service.ts.
function providerUsageCardKey(usage: {
  providerId: string;
  groupId?: string | null;
  accountEmail?: string | null;
}): string {
  return `${usage.providerId}:${usage.groupId ?? ""}:${usage.accountEmail ?? ""}`;
}

interface EventStream {
  event: SessionEventSubscription;
  apply(input: {
    message: SessionOutboundMessage;
    queryClient: QueryClient;
    serverId: string;
  }): void;
}

// Owned-subscription daemons deliver these pushes only to a socket subscribed to them.
const EVENT_STREAMS: Record<EventStreamDomain, EventStream> = {
  notes: {
    event: "notes.changed",
    apply: ({ message, queryClient, serverId }) => {
      if (message.type === "notes.changed") {
        void queryClient.invalidateQueries({ queryKey: notesQueryRoot(serverId) });
      }
    },
  },
  tickets: {
    event: "tickets.changed",
    apply: ({ message, queryClient, serverId }) => {
      // Refetch every active tickets query of this host: one changed ticket
      // also moves derived fields (blocker counts, sub-task progress) of others.
      if (message.type === "tickets.changed") {
        void queryClient.invalidateQueries({ queryKey: ticketsQueryRoot(serverId) });
      }
    },
  },
  missionControlEvents: {
    event: "mission_control_event",
    apply: ({ message, queryClient, serverId }) => {
      if (message.type !== "mission_control_event") return;
      // The feed refetches from the per-host store; a push only marks this host dirty.
      void queryClient.invalidateQueries({ queryKey: missionControlEventsQueryKey(serverId) });
      // M8 instruction ledger: a citing card closes a row, so the ledger
      // refreshes with the same push that refreshes the feed.
      void queryClient.invalidateQueries({
        queryKey: missionControlInstructionsQueryKey(serverId),
      });
    },
  },
  providerUsage: {
    event: "provider.usage.updated",
    apply: ({ message, queryClient, serverId }) => {
      if (message.type === "provider.usage.updated") {
        // COMPAT(fastProviderUsage): per-provider pushes carry only the cards
        // that just refreshed. Merge by (providerId, groupId, accountEmail) so
        // a fast provider never wipes a sibling that is still refreshing.
        queryClient.setQueryData(providerUsageQueryKey(serverId), (current) => {
          const { subscriptionId: _subscriptionId, ...snapshot } = message.payload;
          const previous = (current as { fetchedAt?: string; providers?: unknown[] } | undefined)
            ?.providers;
          if (!Array.isArray(previous)) return snapshot;
          const fresh = snapshot.providers;
          if (!Array.isArray(fresh) || fresh.length === 0) return snapshot;
          const freshKeys = new Set(fresh.map((usage) => providerUsageCardKey(usage)));
          const merged = (previous as typeof fresh).filter(
            (usage) => !freshKeys.has(providerUsageCardKey(usage)),
          );
          return { ...snapshot, providers: [...merged, ...fresh] };
        });
      }
    },
  },
};

export interface ServerDataQueryMeta extends Record<string, unknown> {
  serverData: ServerDataRoute;
}

export type ProvidersSnapshotUpdate = ProvidersSnapshotUpdateMessage;

interface ServerDataPushClient {
  getProvidersSnapshot: import("@getpaseo/client/internal/daemon-client").DaemonClient["getProvidersSnapshot"];
  observeEvents: import("@getpaseo/client/internal/daemon-client").DaemonClient["observeEvents"];
  observeCheckoutDiff: import("@getpaseo/client/internal/daemon-client").DaemonClient["observeCheckoutDiff"];
  observeTerminals: import("@getpaseo/client/internal/daemon-client").DaemonClient["observeTerminals"];
}

interface PushRouterInput {
  client: ServerDataPushClient;
  queryClient: QueryClient;
  serverId: string;
}

interface ActiveServerDataSubscriptions {
  checkoutDiff: Map<string, CheckoutDiffRoute>;
  workspaceTerminals: Map<string, WorkspaceTerminalsRoute>;
}

interface ReconnectRepairPolicy {
  domain: string;
  invalidate(input: { queryClient: QueryClient; serverId: string }): void;
}

const RECONNECT_REPAIR_POLICIES: ReconnectRepairPolicy[] = [
  {
    domain: "providersSnapshot",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });
    },
  },
  {
    domain: "daemonConfig",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
    },
  },
  {
    domain: "daemonPairingOffer",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonPairingOfferQueryKey(serverId) });
    },
  },
  {
    domain: "checkoutDiff",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "checkoutDiff", serverId),
      });
    },
  },
  {
    domain: "workspaceTerminals",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "terminals", serverId),
      });
    },
  },
  {
    domain: "missionControlEvents",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: missionControlEventsQueryKey(serverId) });
      // M8 instruction ledger: a citing card closes a row, so the ledger
      // refreshes with the same push that refreshes the feed.
      void queryClient.invalidateQueries({
        queryKey: missionControlInstructionsQueryKey(serverId),
      });
    },
  },
  {
    domain: "tickets",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryRoot(serverId) });
    },
  },
  {
    domain: "notes",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: notesQueryRoot(serverId) });
    },
  },
];

export function checkoutDiffPushRoute(input: {
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "checkoutDiff",
      enabled: input.enabled,
      serverId: input.serverId,
      subscriptionId: input.subscriptionId,
      cwd: input.cwd,
      compare: input.compare,
    },
  };
}

export function workspaceTerminalsPushRoute(input: {
  enabled: boolean;
  serverId: string;
  cwd: string;
  workspaceId?: string;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "workspaceTerminals",
      enabled: input.enabled,
      serverId: input.serverId,
      cwd: input.cwd,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
  };
}

/**
 * Tickets queries declare this route, so the router holds the tickets.changed
 * stream only for the board host and only while a tickets surface is open.
 */
export function ticketsPushRoute(input: {
  enabled: boolean;
  serverId: string;
}): ServerDataQueryMeta {
  return { serverData: { domain: "tickets", enabled: input.enabled, serverId: input.serverId } };
}
/**
 * Notes queries declare this route, so the router holds the notes.changed
 * stream only for the notes host and only while a notes surface is open.
 */
export function notesPushRoute(input: { enabled: boolean; serverId: string }): ServerDataQueryMeta {
  return { serverData: { domain: "notes", enabled: input.enabled, serverId: input.serverId } };
}

/** Mission Control feed queries hold the mission_control_event stream while a feed is open. */
export function missionControlEventsPushRoute(input: {
  enabled: boolean;
  serverId: string;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "missionControlEvents",
      enabled: input.enabled,
      serverId: input.serverId,
    },
  };
}

/** Provider usage queries hold the provider.usage.updated stream while usage is shown. */
export function providerUsagePushRoute(input: {
  enabled: boolean;
  serverId: string;
}): ServerDataQueryMeta {
  return {
    serverData: { domain: "providerUsage", enabled: input.enabled, serverId: input.serverId },
  };
}

export function invalidateServerDataQueriesAfterReconnect(input: {
  queryClient: QueryClient;
  serverId: string;
}): void {
  for (const policy of RECONNECT_REPAIR_POLICIES) {
    policy.invalidate(input);
  }
}

export async function applyProvidersSnapshotUpdate(input: {
  serverId: string;
  queryClient: QueryClient;
  message: ProvidersSnapshotUpdate;
  client: Pick<ServerDataPushClient, "getProvidersSnapshot">;
  cache?: ProviderSnapshotCache;
}): Promise<void> {
  const snapshot = { ...input.message.payload, requestId: "providers_snapshot_update" };
  const cwd = normalizeProvidersSnapshotCwd(snapshot.cwd);
  const queryKey = providersSnapshotQueryKey(input.serverId, cwd);
  const previous = input.queryClient.getQueryData<{ snapshotHash?: string }>(queryKey);
  let announcement: typeof snapshot | undefined = snapshot;
  void input.queryClient.cancelQueries({ queryKey, exact: true });
  await input.queryClient.fetchQuery({
    queryKey,
    staleTime: 0,
    structuralSharing: false,
    retry: false,
    queryFn: ({ signal }) => {
      const incoming = announcement;
      announcement = undefined;
      return fetchProvidersSnapshot({
        ...input,
        cwd,
        snapshot: incoming,
        signal,
      });
    },
  });
  if (!snapshot.snapshotHash || previous?.snapshotHash !== snapshot.snapshotHash) {
    void input.queryClient.invalidateQueries({
      queryKey: agentCommandsQueryRoot(input.serverId),
      exact: false,
    });
  }
}

export function mountServerDataPushRouter(input: PushRouterInput): () => void {
  const activeCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRegistration>();
  const activeTerminalSubscriptions = new Map<string, WorkspaceTerminalsRegistration>();
  let disposed = false;
  const eventStreamSubscriptions = new Map<EventStreamDomain, OwnedSubscription<unknown>>();

  function reconcileEventStreams(wanted: ReadonlySet<EventStreamDomain>): void {
    for (const [domain, subscription] of eventStreamSubscriptions) {
      if (wanted.has(domain)) continue;
      eventStreamSubscriptions.delete(domain);
      void subscription.release().catch(console.error);
    }
    for (const domain of wanted) {
      if (eventStreamSubscriptions.has(domain)) continue;
      const stream = EVENT_STREAMS[domain];
      const subscription = input.client.observeEvents([stream.event]);
      eventStreamSubscriptions.set(domain, subscription);
      subscription.subscribe({
        snapshot: () => {},
        update: (message) =>
          stream.apply({ message, queryClient: input.queryClient, serverId: input.serverId }),
        error: (error) => {
          if (eventStreamSubscriptions.get(domain) === subscription) {
            eventStreamSubscriptions.delete(domain);
          }
          console.error(`[server-data] observeEvents ${stream.event} failed`, {
            serverId: input.serverId,
            error,
          });
        },
      });
    }
  }

  function reconcileSubscriptions(
    fallbackActive: ActiveServerDataSubscriptions = {
      checkoutDiff: activeCheckoutDiffSubscriptions,
      workspaceTerminals: activeTerminalSubscriptions,
    },
  ): void {
    if (disposed) {
      return;
    }

    const desiredCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRoute>();
    const desiredTerminalSubscriptions = new Map<string, WorkspaceTerminalsRoute>();
    const wantedEventStreams = new Set<EventStreamDomain>();
    for (const query of input.queryClient.getQueryCache().getAll()) {
      const route = getActiveServerDataRoute(query, input.serverId, {
        checkoutDiff: fallbackActive.checkoutDiff,
        workspaceTerminals: fallbackActive.workspaceTerminals,
      });
      if (!route) {
        continue;
      }
      if (route.domain === "checkoutDiff") {
        desiredCheckoutDiffSubscriptions.set(route.subscriptionId, route);
        continue;
      }
      if (route.domain === "workspaceTerminals") {
        desiredTerminalSubscriptions.set(workspaceTerminalSubscriptionKey(route), route);
        continue;
      }
      wantedEventStreams.add(route.domain);
    }

    reconcileCheckoutDiffSubscriptions({
      active: activeCheckoutDiffSubscriptions,
      client: input.client,
      desired: desiredCheckoutDiffSubscriptions,
      serverId: input.serverId,
      queryClient: input.queryClient,
    });
    reconcileTerminalSubscriptions({
      active: activeTerminalSubscriptions,
      client: input.client,
      desired: desiredTerminalSubscriptions,
      apply: (route, payload) =>
        applyTerminalsChanged({
          activeCheckoutDiffSubscriptions,
          activeTerminalSubscriptions,
          queryClient: input.queryClient,
          serverId: input.serverId,
          route,
          message: { type: "terminals_changed", payload },
        }),
    });
    reconcileEventStreams(wantedEventStreams);
  }

  const unsubscribeQueryCache = input.queryClient.getQueryCache().subscribe((event) => {
    if (
      !shouldReconcileSubscriptionsForCacheEvent(event, input.serverId, {
        checkoutDiff: activeCheckoutDiffSubscriptions,
        workspaceTerminals: activeTerminalSubscriptions,
      })
    ) {
      return;
    }
    reconcileSubscriptions();
  });
  const events = input.client.observeEvents([
    "providers_snapshot_update",
    "status.daemon_config_changed",
  ]);
  events.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "providers_snapshot_update") {
        void applyProvidersSnapshotUpdate({
          client: input.client,
          queryClient: input.queryClient,
          serverId: input.serverId,
          message,
        }).catch(() => {
          /* Query state owns fetch failures; reconnect/refetch repairs them. */
        });
      }
      if (message.type === "status")
        applyDaemonConfigStatus({
          queryClient: input.queryClient,
          serverId: input.serverId,
          message,
        });
    },
  });

  reconcileSubscriptions();

  return () => {
    disposed = true;
    unsubscribeQueryCache();
    for (const subscription of eventStreamSubscriptions.values()) {
      void subscription.release().catch(console.error);
    }
    eventStreamSubscriptions.clear();
    void events.release().catch(console.error);
    for (const current of activeCheckoutDiffSubscriptions.values()) {
      void current.subscription.release().catch(console.error);
    }
    activeCheckoutDiffSubscriptions.clear();
    for (const route of activeTerminalSubscriptions.values()) {
      void route.subscription.release().catch(console.error);
    }
    activeTerminalSubscriptions.clear();
  };
}

function reconcileCheckoutDiffSubscriptions(input: {
  active: Map<string, CheckoutDiffRegistration>;
  client: ServerDataPushClient;
  desired: Map<string, CheckoutDiffRoute>;
  serverId: string;
  queryClient: QueryClient;
}): void {
  for (const [key, current] of input.active) {
    const desired = input.desired.get(key);
    if (desired && areCheckoutDiffRoutesEqual(current, desired)) continue;
    input.active.delete(key);
    void current.subscription.release().catch(console.error);
  }
  for (const [key, desired] of input.desired) {
    if (input.active.has(key)) continue;
    const subscription = input.client.observeCheckoutDiff(desired.cwd, desired.compare);
    const registration = { ...desired, subscription };
    input.active.set(key, registration);
    const apply = (
      payload: Omit<CheckoutDiffResponsePayload, "requestId"> & { requestId?: string },
    ) => {
      if (input.active.get(key) !== registration) return;
      const { subscriptionId, ...snapshot } = payload;
      setCheckoutDiffPayload({
        activeCheckoutDiffSubscriptions: input.active,
        queryClient: input.queryClient,
        serverId: input.serverId,
        subscriptionId: key,
        payload: {
          ...snapshot,
          files: orderCheckoutDiffFiles(payload.files),
          requestId: payload.requestId ?? `subscription:${subscriptionId}`,
        },
      });
    };
    subscription.subscribe({
      snapshot: apply,
      update: (message) => {
        if (message.type === "checkout_diff_update") apply(message.payload);
      },
      error: (error) => {
        if (input.active.get(key) === registration) input.active.delete(key);
        console.error("[server-data] observeCheckoutDiff failed", {
          serverId: input.serverId,
          cwd: desired.cwd,
          error,
        });
      },
    });
  }
}

function reconcileTerminalSubscriptions(input: {
  active: Map<string, WorkspaceTerminalsRegistration>;
  client: ServerDataPushClient;
  desired: Map<string, WorkspaceTerminalsRoute>;
  apply(route: WorkspaceTerminalsRoute, payload: TerminalsChangedMessage["payload"]): void;
}): void {
  for (const [key, current] of input.active) {
    const desired = input.desired.get(key);
    if (desired && areWorkspaceTerminalsRoutesEqual(current, desired)) continue;
    input.active.delete(key);
    void current.subscription.release().catch(console.error);
  }
  for (const [key, desired] of input.desired) {
    if (input.active.has(key)) continue;
    const subscription = input.client.observeTerminals(workspaceTerminalSubscriptionInput(desired));
    const registration = { ...desired, subscription };
    input.active.set(key, registration);
    const apply = (payload: TerminalsChangedMessage["payload"]) => {
      if (input.active.get(key) === registration) input.apply(desired, payload);
    };
    subscription.subscribe({
      snapshot: apply,
      update: (message) => {
        if (message.type === "terminals_changed") apply(message.payload);
      },
      error: (error) => {
        if (input.active.get(key) === registration) input.active.delete(key);
        console.error("[server-data] observeTerminals failed", { cwd: desired.cwd, error });
      },
    });
  }
}

function applyDaemonConfigStatus(input: {
  queryClient: QueryClient;
  serverId: string;
  message: StatusMessage;
}): void {
  const payload = input.message.payload;
  if (!isDaemonConfigChangedPayload(payload)) {
    return;
  }
  input.queryClient.setQueryData<MutableDaemonConfig>(
    daemonConfigQueryKey(input.serverId),
    payload.config,
  );
  void input.queryClient.invalidateQueries({
    queryKey: daemonPairingOfferQueryKey(input.serverId),
  });
}

function setCheckoutDiffPayload(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  subscriptionId: string;
  payload: CheckoutDiffCachePayload;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route =
      getServerDataRoute(query) ??
      getActiveCheckoutDiffRouteForQueryKey({
        active: input.activeCheckoutDiffSubscriptions,
        queryKey: query.queryKey,
        serverId: input.serverId,
      });
    if (
      !route ||
      route.domain !== "checkoutDiff" ||
      route.serverId !== input.serverId ||
      route.subscriptionId !== input.subscriptionId
    ) {
      continue;
    }
    query.setOptions({ ...query.options, structuralSharing: shareCheckoutDiff });
    input.queryClient.setQueryData<CheckoutDiffCachePayload>(query.queryKey, input.payload);
  }
}

function applyTerminalsChanged(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  activeTerminalSubscriptions: Map<string, WorkspaceTerminalsRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: TerminalsChangedMessage;
  route: WorkspaceTerminalsRoute;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route = getActiveServerDataRoute(query, input.serverId, {
      checkoutDiff: input.activeCheckoutDiffSubscriptions,
      workspaceTerminals: input.activeTerminalSubscriptions,
    });
    if (
      !route ||
      route.domain !== "workspaceTerminals" ||
      !areWorkspaceTerminalsRoutesEqual(route, input.route)
    ) {
      continue;
    }

    const matchingTerminals = input.message.payload.terminals.filter(
      (terminal) => terminal.workspaceId === route.workspaceId,
    );

    input.queryClient.setQueryData<ListTerminalsPayload>(query.queryKey, (current) => ({
      cwd: input.message.payload.cwd,
      terminals: matchingTerminals,
      requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
    }));
  }
}

function getActiveServerDataRoute(
  query: Query,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): ServerDataRoute | null {
  if (query.getObserversCount() === 0) {
    return null;
  }
  const route = getServerDataRoute(query);
  if (route) {
    return route.enabled && route.serverId === serverId ? route : null;
  }
  return getActiveRouteForQueryKey({
    active,
    queryKey: query.queryKey,
    serverId,
  });
}

function getActiveRouteForQueryKey(input: {
  active: ActiveServerDataSubscriptions;
  queryKey: QueryKey;
  serverId: string;
}): ServerDataRoute | null {
  return (
    getActiveTerminalRouteForQueryKey({
      active: input.active.workspaceTerminals,
      queryKey: input.queryKey,
      serverId: input.serverId,
    }) ??
    getActiveCheckoutDiffRouteForQueryKey({
      active: input.active.checkoutDiff,
      queryKey: input.queryKey,
      serverId: input.serverId,
    })
  );
}

function getActiveTerminalRouteForQueryKey(input: {
  active: Map<string, WorkspaceTerminalsRoute>;
  queryKey: QueryKey;
  serverId: string;
}): WorkspaceTerminalsRoute | null {
  if (!isQueryForServer(input.queryKey, "terminals", input.serverId)) {
    return null;
  }
  const cwd = input.queryKey[2];
  const workspaceId = input.queryKey[3];
  if (
    typeof cwd !== "string" ||
    (workspaceId !== undefined && workspaceId !== null && typeof workspaceId !== "string")
  ) {
    return null;
  }
  return input.active.get(`${cwd}\u0000${workspaceId ?? ""}`) ?? null;
}

function getActiveCheckoutDiffRouteForQueryKey(input: {
  active: Map<string, CheckoutDiffRoute>;
  queryKey: QueryKey;
  serverId: string;
}): CheckoutDiffRoute | null {
  if (!isQueryForServer(input.queryKey, "checkoutDiff", input.serverId)) {
    return null;
  }
  for (const route of input.active.values()) {
    if (isCheckoutDiffQueryKeyForRoute(input.queryKey, route)) {
      return route;
    }
  }
  return null;
}

function shouldReconcileSubscriptionsForCacheEvent(
  event: QueryCacheNotifyEvent,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): boolean {
  if (!canEventChangeDesiredSubscriptions(event.type)) {
    return false;
  }
  const route = getServerDataRoute(event.query);
  if (route?.serverId === serverId) {
    return true;
  }
  return (
    getActiveRouteForQueryKey({
      active,
      queryKey: event.query.queryKey,
      serverId,
    }) !== null
  );
}

function canEventChangeDesiredSubscriptions(type: QueryCacheNotifyEvent["type"]): boolean {
  return (
    type === "added" ||
    type === "removed" ||
    type === "observerAdded" ||
    type === "observerRemoved" ||
    type === "observerOptionsUpdated"
  );
}

function getServerDataRoute(query: Query): ServerDataRoute | null {
  const meta = query.meta;
  if (!isRecord(meta) || !isRecord(meta.serverData)) {
    return null;
  }
  return readServerDataRoute(meta.serverData);
}

function readServerDataRoute(value: Record<string, unknown>): ServerDataRoute | null {
  const domain = value.domain;
  const enabled = value.enabled;
  const serverId = value.serverId;
  const cwd = value.cwd;
  if (typeof enabled !== "boolean" || typeof serverId !== "string") {
    return null;
  }
  if (
    domain === "notes" ||
    domain === "tickets" ||
    domain === "missionControlEvents" ||
    domain === "providerUsage"
  ) {
    return { domain, enabled, serverId };
  }
  if (typeof cwd !== "string") {
    return null;
  }

  if (domain === "checkoutDiff") {
    const subscriptionId = value.subscriptionId;
    const compare = readCheckoutDiffCompare(value.compare);
    if (typeof subscriptionId !== "string" || !compare) {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      subscriptionId,
      cwd,
      compare,
    };
  }

  if (domain === "workspaceTerminals") {
    const workspaceId = value.workspaceId;
    if (workspaceId !== undefined && typeof workspaceId !== "string") {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      cwd,
      ...(workspaceId ? { workspaceId } : {}),
    };
  }

  return null;
}

function readCheckoutDiffCompare(value: unknown): CheckoutDiffCompare | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = value.mode;
  const baseRef = value.baseRef;
  const ignoreWhitespace = value.ignoreWhitespace;
  if (mode !== "uncommitted" && mode !== "base") {
    return null;
  }
  if (baseRef !== undefined && typeof baseRef !== "string") {
    return null;
  }
  if (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean") {
    return null;
  }
  return {
    mode,
    ...(baseRef ? { baseRef } : {}),
    ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
  };
}

function areCheckoutDiffRoutesEqual(
  left: CheckoutDiffRoute | undefined,
  right: CheckoutDiffRoute,
): boolean {
  return (
    left?.serverId === right.serverId &&
    left.subscriptionId === right.subscriptionId &&
    left.cwd === right.cwd &&
    left.compare.mode === right.compare.mode &&
    left.compare.baseRef === right.compare.baseRef &&
    left.compare.ignoreWhitespace === right.compare.ignoreWhitespace
  );
}

function isCheckoutDiffQueryKeyForRoute(queryKey: QueryKey, route: CheckoutDiffRoute): boolean {
  return (
    queryKey[0] === "checkoutDiff" &&
    queryKey[1] === route.serverId &&
    queryKey[2] === route.cwd &&
    queryKey[3] === route.compare.mode &&
    queryKey[4] === (route.compare.baseRef ?? "") &&
    queryKey[5] === (route.compare.ignoreWhitespace === true)
  );
}

function areWorkspaceTerminalsRoutesEqual(
  left: WorkspaceTerminalsRoute,
  right: WorkspaceTerminalsRoute,
): boolean {
  return (
    left.serverId === right.serverId &&
    left.cwd === right.cwd &&
    left.workspaceId === right.workspaceId
  );
}

function workspaceTerminalSubscriptionKey(route: WorkspaceTerminalsRoute): string {
  return `${route.cwd}\u0000${route.workspaceId ?? ""}`;
}

function workspaceTerminalSubscriptionInput(route: WorkspaceTerminalsRoute): {
  cwd: string;
  workspaceId?: string;
} {
  return {
    cwd: route.cwd,
    ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
  };
}

function isQueryForServer(queryKey: QueryKey, kind: string, serverId: string): boolean {
  return queryKey.length >= 2 && queryKey[0] === kind && queryKey[1] === serverId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDaemonConfigChangedPayload(
  payload: StatusMessage["payload"],
): payload is { status: "daemon_config_changed"; config: MutableDaemonConfig } {
  return payload.status === "daemon_config_changed" && isRecord(payload.config);
}
