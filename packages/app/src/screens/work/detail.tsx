import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useWorkItemDetail, useWorkMutations } from "@/data/work";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import type { WorkActivity, WorkComment, WorkItem } from "@getpaseo/protocol/work/types";

interface WorkDetailProps {
  itemId: string;
  onClose?: () => void;
}

function getCommentAuthorLabel(comment: WorkComment): string {
  if (comment.authorKind === "agent") {
    if (comment.authorName) return `Agent · ${comment.authorName}`;
    return "Agent";
  }
  return comment.authorName ?? "You";
}

function priorityLabel(priority: string, translate: (k: string) => string): string {
  const key = `work.card.priority.${priority}`;
  const v = translate(key);
  return v === key ? priority : v;
}

function columnLabel(column: string, translate: (k: string) => string): string {
  const key = `work.column.${column}`;
  const v = translate(key);
  return v === key ? column : v;
}

function bucketLabel(bucket: string, translate: (k: string) => string): string {
  // Bucket values are LifecycleBucket enum strings; display verbatim but via i18n if mapped.
  // Do not derive/mutate bucket — render payload value only.
  const key = `work.bucket.${bucket}`;
  const v = translate(key);
  return v === key ? bucket : v;
}
const CommentRow = memo(function CommentRow({ comment }: { comment: WorkComment }): ReactElement {
  const authorLabel = getCommentAuthorLabel(comment);
  return (
    <View style={styles.commentRow}>
      <Text style={styles.commentAuthor}>{authorLabel}</Text>
      <MarkdownRenderer text={comment.body} compact />
      <Text style={styles.timestamp}>{comment.createdAt}</Text>
    </View>
  );
});

const ActivityRow = memo(function ActivityRow({
  activity,
}: {
  activity: WorkActivity;
}): ReactElement {
  const field = activity.field ? ` ${activity.field}` : "";
  const oldVal = activity.oldValue ?? "—";
  const newVal = activity.newValue ?? "—";
  const hasFieldChange = activity.field !== null && activity.field !== undefined;
  return (
    <View style={styles.activityRow}>
      <Text style={styles.activityText}>
        {activity.verb}
        {field}
        {hasFieldChange ? ` ${oldVal} → ${newVal}` : ""}
      </Text>
      <Text style={styles.timestamp}>{activity.createdAt}</Text>
    </View>
  );
});

const SubItemRow = memo(function SubItemRow({ sub }: { sub: WorkItem }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.subItemRow}>
      <Text style={styles.subItemKey}>{sub.humanKey}</Text>
      <Text style={styles.subItemTitle} numberOfLines={1}>
        {sub.title}
      </Text>
      <Text style={styles.subItemColumn}>
        {columnLabel(sub.column, t as unknown as (k: string) => string)}
      </Text>
      {sub.bucket ? (
        <Text style={styles.subItemBucket}>
          {bucketLabel(sub.bucket, t as unknown as (k: string) => string)}
        </Text>
      ) : null}
    </View>
  );
});

interface WorkDetailHeaderProps {
  item: WorkItem;
  onUpdateTitle: (next: string) => Promise<void>;
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkDetailHeader({ item, onUpdateTitle, t }: WorkDetailHeaderProps): ReactElement {
  const [titleDraft, setTitleDraft] = useState(item.title);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    setTitleDraft(item.title);
    inputRef.current?.replaceText(item.title);
  }, [item.title]);

  const handleTitleSubmit = useCallback(async () => {
    const next = titleDraft.trim();
    if (!next || next === item.title) return;
    setIsSavingTitle(true);
    try {
      await onUpdateTitle(next);
    } finally {
      setIsSavingTitle(false);
    }
  }, [item.title, onUpdateTitle, titleDraft]);

  const hasAgent = Boolean(item.agentId && item.agentHost);
  const columnText = columnLabel(item.column, t as unknown as (k: string) => string);
  const bucketText = item.bucket
    ? bucketLabel(item.bucket, t as unknown as (k: string) => string)
    : null;

  return (
    <View style={styles.header}>
      <Text style={styles.humanKey}>{item.humanKey}</Text>
      <View style={styles.titleRow}>
        <EditingTextInput
          ref={inputRef}
          initialValue={item.title}
          onChangeText={setTitleDraft}
          onBlur={handleTitleSubmit}
          onSubmitEditing={handleTitleSubmit}
          placeholder={item.title}
          style={styles.titleInput}
          testID="work-detail-title"
          editable={!isSavingTitle}
          multiline
        />
        {isSavingTitle ? <Text style={styles.muted}>…</Text> : null}
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.priorityChip}>
          {priorityLabel(item.priority, t as unknown as (k: string) => string)}
        </Text>
        <Text style={styles.metaText}>
          {t("work.detail.column", { defaultValue: "Column" })}: {columnText}
        </Text>
        {hasAgent && bucketText ? (
          <Text style={styles.metaText}>
            {t("work.detail.bucket", { defaultValue: "Agent" })}: {bucketText}
          </Text>
        ) : null}
      </View>
      {item.labelIds.length > 0 ? (
        <View style={styles.labelsRow}>
          {item.labelIds.map((id) => (
            <View key={id} style={styles.labelChip}>
              <Text style={styles.labelText}>{id}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {item.assignment ? (
        <Text style={styles.metaText}>
          {t("work.detail.assignment", { defaultValue: "Assignment" })}: {item.assignment.provider}
          {item.assignment.model ? ` · ${item.assignment.model}` : ""}
        </Text>
      ) : (
        <Text style={styles.muted}>
          {t("work.detail.unassigned", { defaultValue: "Unassigned" })}
        </Text>
      )}
    </View>
  );
}

interface WorkAssignmentSectionProps {
  item: WorkItem;
  onUpdateAssignment: (assignment: WorkItem["assignment"] | null) => Promise<void>;
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkAssignmentSection({
  item,
  onUpdateAssignment,
  t,
}: WorkAssignmentSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [provider, setProvider] = useState(item.assignment?.provider ?? "");
  const [model, setModel] = useState(item.assignment?.model ?? "");
  const [saving, setSaving] = useState(false);
  const providerRef = useRef<EditingTextInputHandle>(null);
  const modelRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    setProvider(item.assignment?.provider ?? "");
    setModel(item.assignment?.model ?? "");
    providerRef.current?.replaceText(item.assignment?.provider ?? "");
    modelRef.current?.replaceText(item.assignment?.model ?? "");
  }, [item.assignment]);

  const handleToggle = useCallback(() => setExpanded((v) => !v), []);

  const handleSave = useCallback(async () => {
    const prov = provider.trim();
    if (!prov) return;
    setSaving(true);
    try {
      await onUpdateAssignment({
        provider: prov,
        ...(model.trim() ? { model: model.trim() } : { model: null }),
        isolation: "worktree",
      });
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  }, [provider, model, onUpdateAssignment]);

  return (
    <View style={styles.section} testID="work-detail-assign">
      <Text style={styles.sectionTitle}>{t("work.detail.assign", { defaultValue: "Assign" })}</Text>
      {item.assignment ? (
        <Text style={styles.metaText}>
          {t("work.detail.assignment", { defaultValue: "Assignment" })}: {item.assignment.provider}
          {item.assignment.model ? ` · ${item.assignment.model}` : ""}
        </Text>
      ) : (
        <Text style={styles.muted}>
          {t("work.detail.unassigned", { defaultValue: "Unassigned" })}
        </Text>
      )}
      {!expanded ? (
        <Button variant="ghost" size="sm" onPress={handleToggle} testID="work-detail-assign">
          {t("work.detail.assign", { defaultValue: "Assign" })}
        </Button>
      ) : (
        <View style={styles.assignForm}>
          <EditingTextInput
            ref={providerRef}
            initialValue={provider}
            onChangeText={setProvider}
            placeholder={t("work.detail.assignProviderPlaceholder", { defaultValue: "Provider" })}
            style={styles.assignInput}
            testID="work-detail-assign-provider"
          />
          <EditingTextInput
            ref={modelRef}
            initialValue={model}
            onChangeText={setModel}
            placeholder={t("work.detail.assignModelPlaceholder", {
              defaultValue: "Model (optional)",
            })}
            style={styles.assignInput}
            testID="work-detail-assign-model"
          />
          <View style={styles.assignActions}>
            <Button variant="ghost" size="sm" onPress={handleToggle}>
              {t("work.detail.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSave}
              disabled={!provider.trim() || saving}
              loading={saving}
              testID="work-detail-assign-submit"
            >
              {saving
                ? t("work.detail.assigning", { defaultValue: "Saving..." })
                : t("work.detail.assignSubmit", { defaultValue: "Save assignment" })}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}

interface WorkDetailActionsProps {
  item: WorkItem;
  onDispatch: () => Promise<void>;
  onCancel: () => Promise<void>;
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkDetailActions({
  item,
  onDispatch,
  onCancel,
  t,
}: WorkDetailActionsProps): ReactElement {
  const isClosed = Boolean(item.closed);
  return (
    <View style={styles.actionsRow}>
      <Button
        variant="secondary"
        size="xs"
        onPress={onDispatch}
        disabled={isClosed}
        testID="work-detail-dispatch"
      >
        {t("work.detail.dispatchNow", { defaultValue: "Dispatch now" })}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onPress={onCancel}
        disabled={isClosed}
        testID="work-detail-close"
      >
        {t("work.detail.cancel", { defaultValue: "Cancel" })}
      </Button>
    </View>
  );
}

interface WorkSubItemListProps {
  subItems: WorkItem[];
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkSubItemList({ subItems, t }: WorkSubItemListProps): ReactElement | null {
  if (subItems.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {t("work.detail.subItems", { defaultValue: "Sub-items" })}
      </Text>
      {subItems.map((sub) => (
        <SubItemRow key={sub.id} sub={sub} />
      ))}
    </View>
  );
}

interface WorkActivityListProps {
  activity: WorkActivity[];
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkActivityList({ activity, t }: WorkActivityListProps): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {t("work.detail.activity", { defaultValue: "Activity" })}
      </Text>
      {activity.length === 0 ? (
        <Text style={styles.muted}>
          {t("work.detail.noActivity", { defaultValue: "No activity yet" })}
        </Text>
      ) : (
        activity.map((a) => <ActivityRow key={a.id} activity={a} />)
      )}
    </View>
  );
}

interface WorkCommentListProps {
  comments: WorkComment[];
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkCommentList({ comments, t }: WorkCommentListProps): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {t("work.detail.comments", { defaultValue: "Comments" })}
      </Text>
      {comments.length === 0 ? (
        <Text style={styles.muted}>
          {t("work.detail.noComments", { defaultValue: "No comments yet" })}
        </Text>
      ) : (
        comments.map((c) => <CommentRow key={c.id} comment={c} />)
      )}
    </View>
  );
}

interface WorkCommentComposerProps {
  itemId: string;
  onCreateComment: (body: string) => Promise<void>;
  t: ReturnType<typeof useTranslation>["t"];
}

function WorkCommentComposer({ onCreateComment, t }: WorkCommentComposerProps): ReactElement {
  const [commentDraft, setCommentDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);

  const handleCreateComment = useCallback(async () => {
    const body = commentDraft.trim();
    if (!body) return;
    setIsSubmitting(true);
    try {
      await onCreateComment(body);
      setCommentDraft("");
      inputRef.current?.replaceText("");
    } finally {
      setIsSubmitting(false);
    }
  }, [commentDraft, onCreateComment]);

  const canSubmit = commentDraft.trim().length > 0 && !isSubmitting;

  return (
    <View style={styles.composer}>
      <EditingTextInput
        ref={inputRef}
        initialValue=""
        onChangeText={setCommentDraft}
        placeholder={t("work.detail.commentPlaceholder", { defaultValue: "Write a comment…" })}
        style={styles.commentInput}
        multiline
        testID="work-detail-comment-input"
      />
      <Button
        onPress={handleCreateComment}
        disabled={!canSubmit}
        loading={isSubmitting}
        size="xs"
        testID="work-detail-comment-submit"
      >
        {t("work.detail.commentSubmit", { defaultValue: "Comment" })}
      </Button>
    </View>
  );
}

function WorkDetailLoading({ t }: { t: ReturnType<typeof useTranslation>["t"] }): ReactElement {
  return (
    <View style={styles.container} testID="work-detail">
      <Text style={styles.muted}>{t("common.loading", { defaultValue: "Loading…" })}</Text>
    </View>
  );
}

function WorkDetailError({ error }: { error: string }): ReactElement {
  return (
    <View style={styles.container} testID="work-detail">
      <Text style={styles.errorText}>{error}</Text>
    </View>
  );
}

function WorkDetailNotFound({ t }: { t: ReturnType<typeof useTranslation>["t"] }): ReactElement {
  return (
    <View style={styles.container} testID="work-detail">
      <Text style={styles.muted}>{t("work.detail.notFound", { defaultValue: "Not found" })}</Text>
    </View>
  );
}

export function WorkDetail({ itemId, onClose }: WorkDetailProps): ReactElement {
  const { t } = useTranslation();
  const { detail, isLoading, error } = useWorkItemDetail(itemId);
  const { updateItem, createComment, dispatchItem, deleteItem } = useWorkMutations();

  const item = detail?.item ?? null;

  const handleUpdateTitle = useCallback(
    async (next: string) => {
      if (!item) return;
      await updateItem({ id: item.id, patch: { title: next } });
    },
    [item, updateItem],
  );

  const handleCreateComment = useCallback(
    async (body: string) => {
      if (!item) return;
      await createComment({ itemId: item.id, body });
    },
    [createComment, item],
  );

  const handleDispatch = useCallback(async () => {
    if (!item) return;
    await dispatchItem({ id: item.id });
  }, [dispatchItem, item]);

  const handleCancel = useCallback(async () => {
    if (!item) return;
    await deleteItem({ id: item.id });
    onClose?.();
  }, [deleteItem, item, onClose]);

  const handleUpdateAssignment = useCallback(
    async (assignment: WorkItem["assignment"] | null) => {
      if (!item) return;
      await updateItem({ id: item.id, patch: { assignment } });
    },
    [item, updateItem],
  );

  if (isLoading && !detail) return <WorkDetailLoading t={t} />;
  if (error) return <WorkDetailError error={error} />;
  if (!item || !detail) return <WorkDetailNotFound t={t} />;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="work-detail"
      keyboardShouldPersistTaps="handled"
    >
      <WorkDetailHeader item={item} onUpdateTitle={handleUpdateTitle} t={t} />
      <WorkDetailActions item={item} onDispatch={handleDispatch} onCancel={handleCancel} t={t} />
      <WorkAssignmentSection item={item} onUpdateAssignment={handleUpdateAssignment} t={t} />
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          {t("work.detail.description", { defaultValue: "Description" })}
        </Text>
        {item.description ? (
          <MarkdownRenderer text={item.description} />
        ) : (
          <Text style={styles.muted}>
            {t("work.detail.noDescription", { defaultValue: "No description" })}
          </Text>
        )}
      </View>
      <WorkSubItemList subItems={detail.subItems} t={t} />
      <WorkActivityList activity={detail.activity} t={t} />
      <WorkCommentList comments={detail.comments} t={t} />
      <WorkCommentComposer itemId={item.id} onCreateComment={handleCreateComment} t={t} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[6],
  },
  header: {
    gap: theme.spacing[2],
  },
  humanKey: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  titleInput: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  priorityChip: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    overflow: "hidden",
  },
  labelsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  labelChip: {
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
  },
  labelText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  section: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  sectionTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  subItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  subItemKey: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  subItemTitle: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  subItemColumn: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  subItemBucket: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  commentRow: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  commentAuthor: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  activityRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  activityText: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  timestamp: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  composer: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  commentInput: {
    minHeight: 80,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    textAlignVertical: "top",
  },
  muted: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  assignForm: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  assignInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
  },
  assignActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
