import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  CreateWebhookOptions,
  DaemonClient,
  TestWebhookOptions,
  UpdateWebhookOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { WebhookDelivery } from "@getpaseo/protocol/webhook/types";
import type {
  AggregatedWebhook,
  FetchAggregatedWebhooksState,
} from "@/webhooks/aggregated-webhooks";
import { webhooksQueryBaseKey } from "@/webhooks/aggregated-webhooks";
import { useSessionStore } from "@/stores/session-store";

export type CreateWebhookInput = Omit<CreateWebhookOptions, "requestId">;
export type UpdateWebhookInput = Omit<UpdateWebhookOptions, "requestId">;
export type TestWebhookInput = Omit<TestWebhookOptions, "requestId">;

export interface WebhookTestResult {
  delivery: WebhookDelivery | null;
  renderedPrompt: string | null;
}

export interface UseWebhookMutationsResult {
  createWebhook: (input: CreateWebhookInput) => Promise<void>;
  updateWebhook: (input: UpdateWebhookInput) => Promise<void>;
  deleteWebhook: (id: string) => Promise<void>;
  testWebhook: (input: TestWebhookInput) => Promise<WebhookTestResult>;
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  isTesting: boolean;
}

interface WebhookListSnapshot {
  previous: Array<[QueryKey, FetchAggregatedWebhooksState | undefined]>;
}

export function updateAggregatedWebhooksData(
  current: FetchAggregatedWebhooksState | undefined,
  updateWebhooks: (webhooks: AggregatedWebhook[]) => AggregatedWebhook[],
): FetchAggregatedWebhooksState | undefined {
  if (!current || current.status !== "loaded") {
    return current;
  }
  return { ...current, data: updateWebhooks(current.data) };
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function snapshotWebhooks(queryClient: QueryClient): WebhookListSnapshot {
  return {
    previous: queryClient.getQueriesData<FetchAggregatedWebhooksState>({
      queryKey: webhooksQueryBaseKey,
    }),
  };
}

function restoreWebhooks(queryClient: QueryClient, snapshot: WebhookListSnapshot): void {
  for (const [queryKey, previous] of snapshot.previous) {
    queryClient.setQueryData(queryKey, previous);
  }
}

function updateWebhooksData(
  queryClient: QueryClient,
  updateWebhooks: (webhooks: AggregatedWebhook[]) => AggregatedWebhook[],
): void {
  queryClient.setQueriesData<FetchAggregatedWebhooksState>(
    { queryKey: webhooksQueryBaseKey },
    (current) => updateAggregatedWebhooksData(current, updateWebhooks),
  );
}

function optimisticallyRemove(queryClient: QueryClient, serverId: string, id: string): void {
  updateWebhooksData(queryClient, (webhooks) =>
    webhooks.filter((webhook) => !(webhook.serverId === serverId && webhook.id === id)),
  );
}

export function useWebhookMutations({ serverId }: { serverId: string }): UseWebhookMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: webhooksQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateWebhookInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.webhookCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateWebhookInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.webhookUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.webhookDelete({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<WebhookListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: webhooksQueryBaseKey });
      const snapshot = snapshotWebhooks(queryClient);
      optimisticallyRemove(queryClient, serverId, id);
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreWebhooks(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const testMutation = useMutation({
    mutationFn: async (input: TestWebhookInput): Promise<WebhookTestResult> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.webhookTest(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { delivery: payload.delivery, renderedPrompt: payload.renderedPrompt };
    },
    onSettled: invalidate,
  });

  const createWebhook = useCallback(
    async (input: CreateWebhookInput): Promise<void> => {
      await createMutation.mutateAsync(input);
    },
    [createMutation],
  );

  const updateWebhook = useCallback(
    async (input: UpdateWebhookInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const deleteWebhook = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const testWebhook = useCallback(
    async (input: TestWebhookInput): Promise<WebhookTestResult> => {
      return testMutation.mutateAsync(input);
    },
    [testMutation],
  );

  return {
    createWebhook,
    updateWebhook,
    deleteWebhook,
    testWebhook,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isTesting: testMutation.isPending,
  };
}
