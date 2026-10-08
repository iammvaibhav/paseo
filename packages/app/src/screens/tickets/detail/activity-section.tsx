import { useCallback, useRef, useState, type ReactElement } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react-native";
import type { TicketActivity } from "@getpaseo/protocol/tickets/types";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { useTicketMutations } from "@/tickets/queries";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatTimeAgo } from "@/utils/time";
import { ACTOR_AVATAR_SIZE, ActorAvatar, actorName } from "./actor-avatar";
import { describeActivityEvent } from "./activity-text";
import { DetailSection, SectionEmpty, SectionHeader } from "./section";
import { isSubmitShortcut } from "./submit-shortcut";
import { useTicketAction } from "./use-ticket-action";

const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const EDIT_ICON = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const DELETE_ICON = <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const COMMENT_MENU_WIDTH = 200;

interface ActivitySectionProps {
  ticketKey: string;
  activity: readonly TicketActivity[];
}

/** Events as one-line sentences and comments as cards, oldest first. */
export function ActivitySection({ ticketKey, activity }: ActivitySectionProps): ReactElement {
  const { t } = useTranslation();
  return (
    <DetailSection testID="ticket-detail-activity">
      <SectionHeader title={t("tickets.detail.activity.title")} />
      {activity.length === 0 ? (
        <SectionEmpty>{t("tickets.detail.activity.empty")}</SectionEmpty>
      ) : (
        <View style={styles.feed}>
          {activity.map((entry) =>
            entry.kind === "comment" ? (
              <CommentCard key={entry.id} comment={entry} ticketKey={ticketKey} />
            ) : (
              <EventLine key={entry.id} event={entry} />
            ),
          )}
        </View>
      )}
    </DetailSection>
  );
}

function EventLine({ event }: { event: TicketActivity }): ReactElement {
  const { t } = useTranslation();
  const name = actorName(event.actor, t);
  return (
    <View style={styles.eventLine} testID={`ticket-activity-${event.id}`}>
      <View style={styles.eventDotSlot}>
        <View style={styles.eventDot} />
      </View>
      <Text style={styles.eventText}>
        <Text style={styles.eventActor}>{name}</Text> {describeActivityEvent(event, t)}
        <Text style={styles.eventTime}> · {formatTimeAgo(new Date(event.createdAt))}</Text>
      </Text>
    </View>
  );
}

function CommentCard({
  comment,
  ticketKey,
}: {
  comment: TicketActivity;
  ticketKey: string;
}): ReactElement {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const name = actorName(comment.actor, t);
  const isOwn = comment.actor.kind === "user";
  const startEditing = useCallback(() => setIsEditing(true), []);
  const stopEditing = useCallback(() => setIsEditing(false), []);
  const time = formatTimeAgo(new Date(comment.createdAt));
  const edited = comment.editedAt ? ` · ${t("tickets.detail.activity.edited")}` : "";

  return (
    <View style={styles.comment} testID={`ticket-comment-${comment.id}`}>
      <ActorAvatar actor={comment.actor} name={name} />
      <View style={styles.commentCard}>
        <View style={styles.commentHeader}>
          <Text style={styles.commentAuthor} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.commentTime} numberOfLines={1}>
            {`${time}${edited}`}
          </Text>
          {isOwn && !isEditing ? (
            <CommentMenu comment={comment} ticketKey={ticketKey} onEdit={startEditing} />
          ) : null}
        </View>
        <View style={styles.commentBody}>
          {isEditing ? (
            <CommentEditor comment={comment} onDone={stopEditing} />
          ) : (
            <MarkdownRenderer text={comment.body ?? ""} />
          )}
        </View>
      </View>
    </View>
  );
}

function renderMenuTrigger({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedMore
      size={ICON_SIZE.sm}
      uniProps={hovered ? foregroundColorMapping : mutedIconColorMapping}
    />
  );
}

function menuTriggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.menuTrigger, hovered && styles.menuTriggerHovered];
}

function CommentMenu({
  comment,
  ticketKey,
  onEdit,
}: {
  comment: TicketActivity;
  ticketKey: string;
  onEdit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { pending, run: deleteComment } = useTicketAction(
    mutations.deleteComment,
    t("tickets.detail.errors.deleteComment"),
  );
  const handleDelete = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("tickets.detail.activity.deleteTitle"),
      message: t("tickets.detail.activity.deleteMessage", { key: ticketKey }),
      confirmLabel: t("tickets.detail.activity.deleteConfirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (confirmed) {
      await deleteComment({ activityId: comment.id });
    }
  }, [comment.id, deleteComment, t, ticketKey]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={menuTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("tickets.detail.activity.commentActions")}
        testID={`ticket-comment-menu-${comment.id}`}
      >
        {renderMenuTrigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={COMMENT_MENU_WIDTH}>
        <DropdownMenuItem leading={EDIT_ICON} onSelect={onEdit}>
          {t("tickets.detail.activity.editComment")}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={DELETE_ICON}
          destructive
          status={pending ? "pending" : "idle"}
          pendingLabel={t("tickets.detail.activity.deleting")}
          onSelect={handleDelete}
        >
          {t("tickets.detail.activity.deleteComment")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommentEditor({
  comment,
  onDone,
}: {
  comment: TicketActivity;
  onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const { pending, run: updateComment } = useTicketAction(
    mutations.updateComment,
    t("tickets.detail.errors.saveComment"),
  );
  const save = useCallback(async () => {
    const body = inputRef.current?.getText().trim() ?? "";
    if (body === "") {
      return;
    }
    if (body === comment.body) {
      onDone();
      return;
    }
    const saved = await updateComment({ activityId: comment.id, body });
    if (saved) {
      onDone();
    }
  }, [comment.body, comment.id, onDone, updateComment]);
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (isSubmitShortcut(event)) {
        event.preventDefault();
        void save();
      }
    },
    [save],
  );

  return (
    <View style={styles.editor}>
      <FormTextInput
        ref={inputRef}
        initialValue={comment.body ?? ""}
        onKeyPress={handleKeyPress}
        multiline
        autoFocus
        accessibilityLabel={t("tickets.detail.activity.editComment")}
        style={styles.editorInput}
      />
      <View style={styles.editorButtons}>
        <Button variant="ghost" size="sm" onPress={onDone} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        <Button variant="secondary" size="sm" onPress={save} loading={pending}>
          {pending ? t("tickets.detail.saving") : t("tickets.detail.activity.saveComment")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  feed: {
    gap: theme.spacing[3],
  },
  eventLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  // The dot column has the avatar's width, so events and comments share one rail.
  eventDotSlot: {
    width: ACTOR_AVATAR_SIZE,
    height: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  eventDot: {
    width: theme.spacing[1.5],
    height: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
  },
  eventText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  eventActor: {
    color: theme.colors.foreground,
  },
  eventTime: {
    color: theme.colors.foregroundMuted,
  },
  comment: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  commentCard: {
    flex: 1,
    minWidth: 0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  commentAuthor: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  commentTime: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  commentBody: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  menuTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  menuTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  editor: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  editorInput: {
    minHeight: theme.spacing[20],
    textAlignVertical: "top",
  },
  editorButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
