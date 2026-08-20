import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWorkMutations, useWorkStickies } from "@/data/work";
import { useSelectedWorkProjectKey } from "@/screens/work/selection-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { WorkSticky } from "@getpaseo/protocol/work/types";

const STICKY_COLORS: Array<{ key: string; value: string | null }> = [
  { key: "default", value: null },
  { key: "yellow", value: "#fef08a" },
  { key: "green", value: "#bbf7d0" },
  { key: "blue", value: "#bfdbfe" },
  { key: "pink", value: "#fecdd3" },
  { key: "amber", value: "#fde68a" },
];

interface ColorSwatchProps {
  swatchKey: string;
  value: string | null;
  selected: boolean;
  onSelect: (value: string | null) => void;
}

const ColorSwatch = memo(function ColorSwatch({
  swatchKey,
  value,
  selected,
  onSelect,
}: ColorSwatchProps): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      onPress={handlePress}
      style={[
        styles.colorSwatch,
        { backgroundColor: value ?? styles.swatchDefault.backgroundColor },
        selected ? styles.colorSwatchSelected : null,
      ]}
      accessibilityLabel={t(`work.stickies.colors.${swatchKey}`)}
    />
  );
});

interface WorkStickyCardProps {
  sticky: WorkSticky;
  onSave: (id: string, body: string, color: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const WorkStickyCard = memo(function WorkStickyCard({
  sticky,
  onSave,
  onDelete,
}: WorkStickyCardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(sticky.body);
  const [color, setColor] = useState<string | null>(sticky.color ?? null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<EditingTextInputHandle>(null);

  const showActions = isHovered || isNative || isCompact;

  useEffect(() => {
    if (!editing) {
      setBody(sticky.body);
      setColor(sticky.color ?? null);
      bodyRef.current?.replaceText(sticky.body);
    }
  }, [sticky.body, sticky.color, editing]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleStartEditing = useCallback(() => setEditing(true), []);
  const handleCancelEditing = useCallback(() => {
    setBody(sticky.body);
    setColor(sticky.color ?? null);
    bodyRef.current?.replaceText(sticky.body);
    setEditing(false);
  }, [sticky.body, sticky.color]);
  const handleDelete = useCallback(() => {
    void onDelete(sticky.id);
  }, [onDelete, sticky.id]);
  const handleSave = useCallback(async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await onSave(sticky.id, body.trim(), color);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [body, color, onSave, sticky.id]);

  const handleSelectColor = useCallback((value: string | null) => setColor(value), []);

  const bg = color ?? styles.stickyCardDefault.backgroundColor;

  if (editing) {
    return (
      <View
        testID={`work-sticky-${sticky.id}`}
        style={[styles.stickyCard, { backgroundColor: bg }]}
      >
        <EditingTextInput
          ref={bodyRef}
          initialValue={body}
          onChangeText={setBody}
          placeholder={t("work.stickies.placeholder")}
          placeholderTextColor={styles.placeholderColor.color}
          style={[styles.stickyInput, styles.stickyInputEditing]}
          multiline
          autoFocus
        />
        <View style={styles.colorRow}>
          {STICKY_COLORS.map((c) => (
            <ColorSwatch
              key={c.key}
              swatchKey={c.key}
              value={c.value}
              selected={color === c.value}
              onSelect={handleSelectColor}
            />
          ))}
        </View>
        <View style={styles.stickyEditActions}>
          <Button size="sm" variant="ghost" onPress={handleCancelEditing}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={handleSave}
            disabled={!body.trim() || saving}
            loading={saving}
          >
            {saving ? t("work.stickies.saving") : t("work.stickies.save")}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View
      testID={`work-sticky-${sticky.id}`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={[styles.stickyCard, { backgroundColor: bg }]}
    >
      <Pressable onPress={handleStartEditing} style={styles.stickyBodyPressable}>
        <Text style={styles.stickyBody} numberOfLines={8}>
          {sticky.body}
        </Text>
      </Pressable>
      {showActions ? (
        <View style={styles.stickyActions}>
          <Pressable onPress={handleStartEditing} hitSlop={8}>
            <Text style={styles.stickyActionText}>{t("work.stickies.save")}</Text>
          </Pressable>
          <Pressable onPress={handleDelete} hitSlop={8}>
            <Text style={[styles.stickyActionText, styles.stickyActionDanger]}>
              {t("work.stickies.delete")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

interface StickyColorSwatchProps {
  swatchKey: string;
  value: string | null;
  selected: boolean;
  onSelect: (value: string | null) => void;
}

const StickyCreateSwatch = memo(function StickyCreateSwatch({
  swatchKey,
  value,
  selected,
  onSelect,
}: StickyColorSwatchProps): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      onPress={handlePress}
      style={[
        styles.colorSwatch,
        { backgroundColor: value ?? styles.swatchDefault.backgroundColor },
        selected ? styles.colorSwatchSelected : null,
      ]}
      accessibilityLabel={t(`work.stickies.colors.${swatchKey}`)}
    />
  );
});

export function WorkStickies(): ReactElement {
  const { t } = useTranslation();
  const projectKey = useSelectedWorkProjectKey();
  const { rows, isLoading, error } = useWorkStickies(projectKey);
  const { upsertSticky, deleteSticky } = useWorkMutations();

  const [newBody, setNewBody] = useState("");
  const [newColor, setNewColor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const newBodyRef = useRef<EditingTextInputHandle>(null);

  const handleCreate = useCallback(async () => {
    if (!projectKey || !newBody.trim()) return;
    setCreating(true);
    try {
      await upsertSticky({
        projectKey,
        sticky: { body: newBody.trim(), ...(newColor ? { color: newColor } : {}) },
      });
      setNewBody("");
      setNewColor(null);
      newBodyRef.current?.replaceText("");
    } finally {
      setCreating(false);
    }
  }, [projectKey, newBody, newColor, upsertSticky]);

  const handleSave = useCallback(
    async (id: string, body: string, _color: string | null) => {
      if (!projectKey) return;
      await upsertSticky({ projectKey, sticky: { id, body } });
    },
    [projectKey, upsertSticky],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await confirmDialog({
        title: t("work.stickies.delete"),
        message: t("work.stickies.delete"),
        destructive: true,
        confirmLabel: t("work.stickies.delete"),
      });
      if (!ok) return;
      await deleteSticky({ id });
    },
    [deleteSticky, t],
  );

  const handleSelectNewColor = useCallback((value: string | null) => setNewColor(value), []);

  if (!projectKey) {
    return (
      <View testID="work-stickies" style={styles.center}>
        <Text style={styles.muted}>{t("work.states.noProject")}</Text>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View testID="work-stickies" style={styles.center}>
        <LoadingSpinner color={styles.spinnerColor.color} />
        <Text style={styles.muted}>{t("work.states.loading")}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View testID="work-stickies" style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <View testID="work-stickies" style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.sectionTitle}>{t("work.stickies.title")}</Text>
          <Text style={styles.hint}>{t("work.stickies.emptyHint")}</Text>
        </View>

        <View style={styles.createCard} testID="work-sticky-new">
          <EditingTextInput
            ref={newBodyRef}
            initialValue={newBody}
            onChangeText={setNewBody}
            placeholder={t("work.stickies.placeholder")}
            placeholderTextColor={styles.placeholderColor.color}
            style={[styles.input, styles.inputMultiline]}
            multiline
          />
          <View style={styles.colorRow}>
            <Text style={styles.colorLabel}>{t("work.stickies.colorLabel")}</Text>
            <View style={styles.colorSwatches}>
              {STICKY_COLORS.map((c) => (
                <StickyCreateSwatch
                  key={c.key}
                  swatchKey={c.key}
                  value={c.value}
                  selected={newColor === c.value}
                  onSelect={handleSelectNewColor}
                />
              ))}
            </View>
          </View>
          <View style={styles.createActions}>
            <Button
              size="sm"
              variant="default"
              onPress={handleCreate}
              disabled={!newBody.trim() || creating}
              loading={creating}
            >
              {creating ? t("work.stickies.creating") : t("work.stickies.create")}
            </Button>
          </View>
        </View>

        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.muted}>{t("work.stickies.empty")}</Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {rows.map((sticky) => (
              <WorkStickyCard
                key={sticky.id}
                sticky={sticky}
                onSave={handleSave}
                onDelete={handleDelete}
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
  colorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  colorLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  colorSwatches: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  colorSwatchSelected: {
    borderColor: theme.colors.foreground,
    borderWidth: 2,
  },
  createActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  empty: {
    alignItems: "center",
    padding: theme.spacing[6],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  stickyCard: {
    width: 220,
    minHeight: 140,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  stickyCardDefault: {
    backgroundColor: theme.colors.surface1,
  },
  swatchDefault: {
    backgroundColor: theme.colors.surface2,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  stickyBodyPressable: {
    flex: 1,
  },
  stickyBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  stickyInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    backgroundColor: theme.colors.surface0,
  },
  stickyInputEditing: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  stickyEditActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  stickyActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  stickyActionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  stickyActionDanger: {
    color: theme.colors.statusDanger,
  },
}));
