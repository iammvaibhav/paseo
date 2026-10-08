import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Paperclip, Plus, Trash2 } from "lucide-react-native";
import type { TicketAttachment, TicketDetail } from "@getpaseo/protocol/tickets/types";
import type { SelectedFile } from "@/attachments/selected-file";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useTicketMutations } from "@/tickets/queries";
import { ICON_SIZE } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { encodeBytesToBase64, openAttachmentFile } from "./attachment-file";
import { DetailSection, SectionEmpty, SectionHeader } from "./section";
import { formatFileSize } from "./ticket-fields";
import { useTicketAction } from "./use-ticket-action";

const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash = withUnistyles(Trash2);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const FILE_ICON = <ThemedPaperclip size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const ADD_ICON = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const DELETE_ICON = <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;

// The board host refuses larger files; checking first saves the upload.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function AttachmentsSection({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useTicketMutations();
  const { pickFiles } = useFilePicker();
  const [uploading, setUploading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const { run: upload } = useTicketAction(
    mutations.addAttachment,
    t("tickets.detail.errors.addAttachment"),
  );
  const { run: remove } = useTicketAction(
    mutations.deleteAttachment,
    t("tickets.detail.errors.deleteAttachment"),
  );

  const reportAddFailure = useCallback(
    (error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
      toast.error(
        t("tickets.detail.errors.withReason", {
          action: t("tickets.detail.errors.addAttachment"),
          message: error.message,
        }),
      );
    },
    [t, toast],
  );

  const handleAdd = useCallback(async () => {
    let files: SelectedFile[] | null;
    try {
      files = await pickFiles();
    } catch (error) {
      reportAddFailure(error);
      return;
    }
    if (!files) {
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        const bytes = await file.readBytes();
        if (bytes.length > MAX_ATTACHMENT_BYTES) {
          toast.error(t("tickets.detail.attachments.tooLarge", { file: file.fileName }));
          continue;
        }
        await upload({
          ticketId: ticket.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          dataBase64: encodeBytesToBase64(bytes),
        });
      }
    } catch (error) {
      reportAddFailure(error);
    } finally {
      setUploading(false);
    }
  }, [pickFiles, reportAddFailure, t, ticket.id, toast, upload]);

  const handleOpen = useCallback(
    async (attachment: TicketAttachment) => {
      setOpeningId(attachment.id);
      try {
        const content = await mutations.readAttachment({ attachmentId: attachment.id });
        await openAttachmentFile(content);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        toast.error(
          t("tickets.detail.errors.withReason", {
            action: t("tickets.detail.errors.openAttachment"),
            message: error.message,
          }),
        );
      } finally {
        setOpeningId(null);
      }
    },
    [mutations, t, toast],
  );

  const handleDelete = useCallback(
    async (attachment: TicketAttachment) => {
      const confirmed = await confirmDialog({
        title: t("tickets.detail.attachments.deleteTitle"),
        message: t("tickets.detail.attachments.deleteMessage", {
          file: attachment.fileName,
          key: ticket.key,
        }),
        confirmLabel: t("tickets.detail.attachments.deleteConfirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (confirmed) {
        await remove({ attachmentId: attachment.id });
      }
    },
    [remove, t, ticket.key],
  );

  return (
    <DetailSection testID="ticket-detail-attachments">
      <SectionHeader
        title={t("tickets.detail.attachments.title")}
        tally={ticket.attachments.length > 0 ? String(ticket.attachments.length) : undefined}
      >
        <Button
          variant="ghost"
          size="xs"
          leftIcon={ADD_ICON}
          loading={uploading}
          onPress={handleAdd}
          testID="ticket-detail-attachments-add"
        >
          {uploading
            ? t("tickets.detail.attachments.uploading")
            : t("tickets.detail.attachments.add")}
        </Button>
      </SectionHeader>
      {ticket.attachments.length === 0 ? (
        <SectionEmpty>{t("tickets.detail.attachments.empty")}</SectionEmpty>
      ) : (
        ticket.attachments.map((attachment) => (
          <AttachmentRow
            key={attachment.id}
            attachment={attachment}
            opening={openingId === attachment.id}
            onOpen={handleOpen}
            onDelete={handleDelete}
          />
        ))
      )}
    </DetailSection>
  );
}

interface AttachmentRowProps {
  attachment: TicketAttachment;
  opening: boolean;
  onOpen: (attachment: TicketAttachment) => void;
  onDelete: (attachment: TicketAttachment) => void;
}

function AttachmentRow({
  attachment,
  opening,
  onOpen,
  onDelete,
}: AttachmentRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleOpen = useCallback(() => onOpen(attachment), [attachment, onOpen]);
  const handleDelete = useCallback(() => onDelete(attachment), [attachment, onDelete]);
  const showDelete = isHovered || isCompact || isNative;
  const meta = `${formatFileSize(attachment.size)} · ${formatTimeAgo(new Date(attachment.createdAt))}`;

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      isHovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isHovered],
  );

  return (
    <View
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={handleOpen}
        disabled={opening}
        accessibilityRole="button"
        accessibilityLabel={t("tickets.detail.attachments.open", { file: attachment.fileName })}
        testID={`ticket-attachment-${attachment.id}`}
      >
        <View style={styles.icon}>
          {opening ? (
            <ThemedLoadingSpinner size="small" uniProps={mutedIconColorMapping} />
          ) : (
            FILE_ICON
          )}
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {attachment.fileName}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        <View style={showDelete ? styles.deleteSlot : styles.deleteSlotHidden}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={DELETE_ICON}
            onPress={handleDelete}
            accessibilityLabel={t("tickets.detail.attachments.delete", {
              file: attachment.fileName,
            })}
            testID={`ticket-attachment-delete-${attachment.id}`}
          />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
  },
  row: {
    minHeight: CONTROL_HEIGHTS.compact,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  icon: {
    width: ICON_SIZE.md,
    alignItems: "center",
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  meta: {
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  deleteSlot: {
    opacity: 1,
  },
  deleteSlotHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
}));
