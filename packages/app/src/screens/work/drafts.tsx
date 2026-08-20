import { memo, useCallback, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWorkDrafts, useWorkMutations } from "@/data/work";
import { useWorkProjectHost } from "@/data/work";
import { useSelectedWorkProjectKey } from "@/screens/work/selection-store";
import type { WorkDraft, WorkPriority } from "@getpaseo/protocol/work/types";

const PRIORITIES: WorkPriority[] = ["urgent", "high", "medium", "low", "none"];

interface WorkDraftCardProps {
  draft: WorkDraft;
  onPromote: (id: string) => void;
  promoting: boolean;
  promotedKey: string | null;
}

const WorkDraftCard = memo(function WorkDraftCard({
  draft,
  onPromote,
  promoting,
  promotedKey,
}: WorkDraftCardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const showActions = isHovered || isNative || isCompact;

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePromote = useCallback(() => onPromote(draft.id), [onPromote, draft.id]);

  return (
    <View
      testID={`work-draft-${draft.id}`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={[styles.card, promotedKey ? styles.cardPromoted : null]}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {draft.title}
        </Text>
        {draft.priority && draft.priority !== "none" ? (
          <View style={styles.priorityChip}>
            <Text style={styles.priorityText}>{t(`work.priority.${draft.priority}`)}</Text>
          </View>
        ) : null}
      </View>
      {draft.description ? (
        <Text style={styles.cardDescription} numberOfLines={3}>
          {draft.description}
        </Text>
      ) : null}
      {draft.labelIds && draft.labelIds.length > 0 ? (
        <View style={styles.labelRow}>
          {draft.labelIds.map((lid) => (
            <View key={lid} style={styles.labelChipMuted}>
              <Text style={styles.labelText}>{lid}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {draft.assignment ? (
        <Text style={styles.metaText} numberOfLines={1}>
          {draft.assignment.provider}
          {draft.assignment.model ? ` · ${draft.assignment.model}` : ""}
        </Text>
      ) : null}
      {promotedKey ? (
        <View style={styles.promotedBanner}>
          <Text style={styles.promotedText}>
            {t("work.drafts.promotedTo", { key: promotedKey })}
          </Text>
        </View>
      ) : null}
      <View style={styles.cardActions}>
        {showActions ? (
          <Button
            testID={`work-draft-promote-${draft.id}`}
            size="sm"
            variant="secondary"
            onPress={handlePromote}
            disabled={promoting || Boolean(promotedKey)}
            loading={promoting}
          >
            {promoting ? t("work.drafts.promoting") : t("work.drafts.promote")}
          </Button>
        ) : (
          <View style={styles.actionsPlaceholder} />
        )}
      </View>
    </View>
  );
});

interface PriorityOptionProps {
  value: WorkPriority;
  selected: boolean;
  onSelect: (value: WorkPriority) => void;
}

const PriorityOption = memo(function PriorityOption({
  value,
  selected,
  onSelect,
}: PriorityOptionProps): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.priorityOption, selected ? styles.priorityOptionSelected : null]}
    >
      <Text
        style={[styles.priorityOptionText, selected ? styles.priorityOptionTextSelected : null]}
      >
        {t(`work.priority.${value}`)}
      </Text>
    </Pressable>
  );
});

export function WorkDrafts(): ReactElement {
  const { t } = useTranslation();
  const projectKey = useSelectedWorkProjectKey();
  const { rows, isLoading, error } = useWorkDrafts(projectKey);
  const { createDraft, promoteDraft } = useWorkMutations();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkPriority>("none");
  const [labelIdsText, setLabelIdsText] = useState("");
  const [assignmentProvider, setAssignmentProvider] = useState("");
  const [creating, setCreating] = useState(false);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promotedKeys, setPromotedKeys] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const titleRef = useRef<EditingTextInputHandle>(null);
  const descriptionRef = useRef<EditingTextInputHandle>(null);
  const labelIdsRef = useRef<EditingTextInputHandle>(null);
  const assignmentRef = useRef<EditingTextInputHandle>(null);

  const handleCreate = useCallback(async () => {
    if (!projectKey || !title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const labelIds = labelIdsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const assignment = assignmentProvider.trim()
        ? { provider: assignmentProvider.trim(), isolation: "worktree" as const }
        : undefined;
      await createDraft({
        projectKey,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(priority !== "none" ? { priority } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(assignment ? { assignment } : {}),
      });
      setTitle("");
      setDescription("");
      setPriority("none");
      setLabelIdsText("");
      setAssignmentProvider("");
      titleRef.current?.replaceText("");
      descriptionRef.current?.replaceText("");
      labelIdsRef.current?.replaceText("");
      assignmentRef.current?.replaceText("");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [projectKey, title, description, priority, labelIdsText, assignmentProvider, createDraft]);

  const handlePromote = useCallback(
    async (id: string) => {
      setPromotingId(id);
      setPromoteError(null);
      try {
        const item = await promoteDraft({ id });
        if (!item) {
          setPromoteError("No item returned");
          return;
        }
        const hasHumanKey = item && typeof item === "object" && "humanKey" in item;
        const humanKeyValue = hasHumanKey ? item.humanKey : undefined;
        const humanKey =
          typeof humanKeyValue === "string" && humanKeyValue.length > 0
            ? humanKeyValue
            : String(item.id);
        setPromotedKeys((prev) => ({ ...prev, [id]: humanKey }));
      } catch (e) {
        setPromoteError(e instanceof Error ? e.message : String(e));
      } finally {
        setPromotingId(null);
      }
    },
    [promoteDraft],
  );

  const handleSelectPriority = useCallback((value: WorkPriority) => setPriority(value), []);

  const { isCapable: isCapableForGate, hostLabel: hostLabelForGate } =
    useWorkProjectHost(projectKey);

  if (!projectKey) {
    return (
      <View testID="work-drafts" style={styles.center}>
        <Text style={styles.muted}>{t("work.states.noProject")}</Text>
      </View>
    );
  }

  if (isCapableForGate === false) {
    return (
      <View testID="work-host-needs-update" style={styles.center}>
        <Text style={styles.error}>{t("work.host.needsUpdateTitle")}</Text>
        <Text style={styles.muted}>
          {hostLabelForGate
            ? t("work.host.needsUpdateDetail", { host: hostLabelForGate })
            : t("work.host.needsUpdateDetailGeneric")}
        </Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View testID="work-drafts" style={styles.center}>
        <LoadingSpinner color={styles.spinnerColor.color} />
        <Text style={styles.muted}>{t("work.states.loading")}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View testID="work-drafts" style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <View testID="work-drafts" style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.sectionTitle}>{t("work.drafts.title")}</Text>
          <Text style={styles.hint}>{t("work.drafts.emptyHint")}</Text>
        </View>

        <View style={styles.createCard} testID="work-draft-new">
          <Text style={styles.label}>{t("work.drafts.newDraft")}</Text>
          <EditingTextInput
            ref={titleRef}
            initialValue={title}
            onChangeText={setTitle}
            placeholder={t("work.drafts.titlePlaceholder")}
            placeholderTextColor={styles.placeholderColor.color}
            style={styles.input}
          />
          <EditingTextInput
            ref={descriptionRef}
            initialValue={description}
            onChangeText={setDescription}
            placeholder={t("work.drafts.descriptionPlaceholder")}
            placeholderTextColor={styles.placeholderColor.color}
            style={[styles.input, styles.inputMultiline]}
            multiline
          />
          <View style={styles.fieldRow}>
            <View style={styles.fieldCol}>
              <Text style={styles.fieldLabel}>{t("work.drafts.priorityLabel")}</Text>
              <View style={styles.priorityRow}>
                {PRIORITIES.map((p) => (
                  <PriorityOption
                    key={p}
                    value={p}
                    selected={priority === p}
                    onSelect={handleSelectPriority}
                  />
                ))}
              </View>
            </View>
          </View>
          <EditingTextInput
            ref={labelIdsRef}
            initialValue={labelIdsText}
            onChangeText={setLabelIdsText}
            placeholder={t("work.drafts.labelsPlaceholder")}
            placeholderTextColor={styles.placeholderColor.color}
            style={styles.input}
          />
          <EditingTextInput
            ref={assignmentRef}
            initialValue={assignmentProvider}
            onChangeText={setAssignmentProvider}
            placeholder={t("work.drafts.assignmentPlaceholder")}
            placeholderTextColor={styles.placeholderColor.color}
            style={styles.input}
          />
          {createError ? <Alert variant="error" title={createError} /> : null}
          <View style={styles.createActions}>
            <Button
              size="sm"
              variant="default"
              onPress={handleCreate}
              disabled={!title.trim() || creating}
              loading={creating}
            >
              {creating ? t("work.drafts.creating") : t("work.drafts.create")}
            </Button>
          </View>
        </View>

        {promoteError ? (
          <View style={styles.alertWrap}>
            <Alert variant="error" title={promoteError} />
          </View>
        ) : null}

        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.muted}>{t("work.drafts.empty")}</Text>
            <Text style={styles.hint}>{t("work.drafts.emptyHint")}</Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {rows.map((draft) => (
              <WorkDraftCard
                key={draft.id}
                draft={draft}
                onPromote={handlePromote}
                promoting={promotingId === draft.id}
                promotedKey={promotedKeys[draft.id] ?? null}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  scrollContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  header: {
    gap: theme.spacing[1],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  createCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  fieldRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  fieldCol: {
    flex: 1,
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    backgroundColor: theme.colors.surface0,
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  priorityRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  priorityOption: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  priorityOptionSelected: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.foreground,
  },
  priorityOptionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  priorityOptionTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  createActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  alertWrap: {
    marginHorizontal: theme.spacing[1],
  },
  empty: {
    alignItems: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[1],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  card: {
    width: 320,
    maxWidth: "100%",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardPromoted: {
    borderColor: theme.colors.statusSuccess,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  priorityChip: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  priorityText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  cardDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  labelChipMuted: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  labelText: {
    fontSize: 11,
    color: theme.colors.foreground,
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  promotedBanner: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.statusSuccess,
  },
  promotedText: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  cardActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    minHeight: 32,
    alignItems: "center",
  },
  actionsPlaceholder: {
    height: 32,
  },
}));
