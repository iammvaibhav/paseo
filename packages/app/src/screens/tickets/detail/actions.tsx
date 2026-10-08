import { useCallback, type ReactElement } from "react";
import { View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import * as Linking from "expo-linking";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Archive, ArchiveRestore, Link2, MoreHorizontal, Play, Trash2 } from "lucide-react-native";
import type { TicketDetail } from "@getpaseo/protocol/tickets/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useTicketMutations } from "@/tickets/queries";
import { buildTicketsRoute } from "@/tickets/routes";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { useTicketAction } from "./use-ticket-action";

const ThemedPlay = withUnistyles(Play);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedLink = withUnistyles(Link2);
const ThemedArchive = withUnistyles(Archive);
const ThemedRestore = withUnistyles(ArchiveRestore);
const ThemedTrash = withUnistyles(Trash2);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const DISPATCH_ICON = <ThemedPlay size={ICON_SIZE.xs} uniProps={mutedIconColorMapping} />;
const LINK_ICON = <ThemedLink size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const ARCHIVE_ICON = <ThemedArchive size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const RESTORE_ICON = <ThemedRestore size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const DELETE_ICON = <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const MENU_WIDTH = 220;

interface TicketActionsProps {
  ticket: TicketDetail;
  onDeleted: () => void;
}

/** Dispatch now, and the ticket's menu: copy link, archive or restore, delete. */
export function TicketActions({ ticket, onDeleted }: TicketActionsProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useTicketMutations();
  const { pending: dispatching, run: dispatchTicket } = useTicketAction(
    mutations.dispatchTicket,
    t("tickets.detail.errors.dispatch"),
  );
  const { pending: archiving, run: updateTicket } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.archive"),
  );
  const { pending: deleting, run: deleteTicket } = useTicketAction(
    mutations.deleteTicket,
    t("tickets.detail.errors.delete"),
  );
  const isArchived = ticket.archivedAt !== null;

  const handleDispatch = useCallback(async () => {
    const dispatched = await dispatchTicket({ ticketId: ticket.id });
    if (dispatched) {
      toast.show(t("tickets.detail.actions.dispatched", { key: ticket.key }), {
        variant: "success",
      });
    }
  }, [dispatchTicket, t, ticket.id, ticket.key, toast]);

  const handleCopyLink = useCallback(() => {
    const url = Linking.createURL(buildTicketsRoute({ board: ticket.boardId, ticket: ticket.key }));
    copyToClipboard(url)
      .then(() => toast.copied(t("tickets.detail.actions.link")))
      .catch(() => toast.error(t("common.errors.unableToCopy")));
  }, [t, ticket.boardId, ticket.key, toast]);

  const handleArchive = useCallback(() => {
    void updateTicket({ ticketId: ticket.id, archived: !isArchived });
  }, [isArchived, ticket.id, updateTicket]);

  const handleDelete = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("tickets.detail.actions.deleteTitle", { key: ticket.key }),
      message: t("tickets.detail.actions.deleteMessage"),
      confirmLabel: t("tickets.detail.actions.deleteConfirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    const deleted = await deleteTicket({ ticketId: ticket.id });
    if (deleted) {
      onDeleted();
    }
  }, [deleteTicket, onDeleted, t, ticket.id, ticket.key]);

  return (
    <View style={styles.actions}>
      <Button
        variant="secondary"
        size="xs"
        leftIcon={DISPATCH_ICON}
        loading={dispatching}
        disabled={isArchived}
        onPress={handleDispatch}
        testID="ticket-detail-dispatch"
      >
        {dispatching
          ? t("tickets.detail.actions.dispatching")
          : t("tickets.detail.actions.dispatch")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          hitSlop={8}
          style={menuTriggerStyle}
          accessibilityRole={isNative ? "button" : undefined}
          accessibilityLabel={t("tickets.detail.actions.more")}
          testID="ticket-detail-menu"
        >
          {renderMenuTrigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={MENU_WIDTH}>
          <DropdownMenuItem leading={LINK_ICON} onSelect={handleCopyLink}>
            {t("tickets.detail.actions.copyLink")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={isArchived ? RESTORE_ICON : ARCHIVE_ICON}
            status={archiving ? "pending" : "idle"}
            pendingLabel={t("tickets.detail.saving")}
            onSelect={handleArchive}
            testID="ticket-detail-archive"
          >
            {isArchived ? t("tickets.detail.actions.restore") : t("tickets.detail.actions.archive")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={DELETE_ICON}
            destructive
            status={deleting ? "pending" : "idle"}
            pendingLabel={t("tickets.detail.actions.deleting")}
            onSelect={handleDelete}
            testID="ticket-detail-delete"
          >
            {t("tickets.detail.actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function renderMenuTrigger({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedMore
      size={ICON_SIZE.md}
      uniProps={hovered ? foregroundColorMapping : mutedIconColorMapping}
    />
  );
}

function menuTriggerStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.menuTrigger, (hovered || pressed) && styles.menuTriggerActive];
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  menuTrigger: {
    padding: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  menuTriggerActive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
}));
