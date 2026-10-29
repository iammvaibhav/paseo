import { useCallback, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WebhookRow, type WebhookRowPending } from "@/components/webhooks/webhook-row";
import { useWebhookMutations } from "@/hooks/use-webhook-mutations";
import type { AggregatedWebhook } from "@/hooks/use-webhooks";
import { resolveWebhookTitle } from "@/webhooks/webhook-derivation";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

/** A webhook plus the client-derived fields the row renders. */
export interface WebhookRowView {
  webhook: AggregatedWebhook;
  targetLabel: string;
  provider: string | null;
  serverName: string;
  /** True when only one host exists, so the host name is redundant in rows. */
  singleHost: boolean;
}

interface WebhooksTableProps {
  rows: WebhookRowView[];
  /**
   * The form sheet is owned by the screen (it serves both create and edit and
   * shares the screen's "New webhook" button), so the table delegates edit
   * upward rather than mounting a second sheet here.
   */
  onEditWebhook: (webhook: AggregatedWebhook) => void;
}

/**
 * The webhooks list: a single settings-style card of rows across every
 * connected host, in a full-width list matching the History screen. Rows own
 * their host-scoped mutations (delete via the mutations hook + a destructive
 * confirm) and delegate editing upward.
 */
export function WebhooksTable({ rows, onEditWebhook }: WebhooksTableProps): ReactElement {
  return (
    <View style={styles.listContent} testID="webhooks-table">
      <View style={settingsStyles.card}>
        {rows.map((row, index) => (
          <WebhooksTableRow
            key={`${row.webhook.serverId}:${row.webhook.id}`}
            row={row}
            isFirst={index === 0}
            onEditWebhook={onEditWebhook}
          />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-row wrapper owns local in-flight state and binds mutations to this
// webhook's host. Local state keeps pending precise to the acting row even
// when several rows are acted on at once (the mutations hook exposes only a
// single global pending flag per action).
// ---------------------------------------------------------------------------

const NO_PENDING: WebhookRowPending = {};

function WebhooksTableRow({
  row,
  isFirst,
  onEditWebhook,
}: {
  row: WebhookRowView;
  isFirst: boolean;
  onEditWebhook: (webhook: AggregatedWebhook) => void;
}): ReactElement {
  const { webhook } = row;
  const { id, serverId } = webhook;
  const mutations = useWebhookMutations({ serverId });
  const [pending, setPending] = useState<WebhookRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (key: keyof WebhookRowPending, action: () => Promise<void>): Promise<void> => {
      setPending((current) => ({ ...current, [key]: true }));
      try {
        await action();
      } catch {
        // Mutations roll back their own optimistic cache writes on error and
        // re-fetch on settle; surfacing per-row toasts here is out of scope.
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  const handleEdit = useCallback(() => {
    onEditWebhook(webhook);
  }, [onEditWebhook, webhook]);

  const handleDelete = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: "Delete webhook",
        message: `Delete "${resolveWebhookTitle(webhook)}"? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await runAction("delete", () => mutations.deleteWebhook(id));
    })();
  }, [runAction, mutations, id, webhook]);

  return (
    <WebhookRow
      webhook={webhook}
      targetLabel={row.targetLabel}
      provider={row.provider}
      serverName={row.serverName}
      singleHost={row.singleHost}
      isFirst={isFirst}
      pending={pending}
      onEdit={handleEdit}
      onDelete={handleDelete}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Full-width list padding matching the History screen.
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
}));
