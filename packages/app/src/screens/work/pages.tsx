import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWorkMutations, useWorkPages } from "@/data/work";
import { useWorkProjectHost } from "@/data/work";
import { useSelectedWorkProjectKey } from "@/screens/work/selection-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { WorkPage } from "@getpaseo/protocol/work/types";

interface WorkPageRowProps {
  page: WorkPage;
  depth: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

const WorkPageRow = memo(function WorkPageRow({
  page,
  depth,
  selected,
  onSelect,
  onDelete,
}: WorkPageRowProps): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const showActions = isHovered || isNative || isCompact;

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleSelect = useCallback(() => onSelect(page.id), [onSelect, page.id]);
  const handleDeletePress = useCallback(
    (e: GestureResponderEvent) => {
      e.stopPropagation?.();
      onDelete(page.id);
    },
    [onDelete, page.id],
  );

  const pressableStyle = useMemo(
    () => [styles.rowPressable, { paddingLeft: 12 + depth * 16 }],
    [depth],
  );
  const wrapStyle = useMemo(
    () => [styles.rowWrap, selected ? styles.rowWrapSelected : null],
    [selected],
  );

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave} style={wrapStyle}>
      <Pressable testID={`work-page-${page.id}`} onPress={handleSelect} style={pressableStyle}>
        <View style={styles.rowMain}>
          <Text
            style={[styles.rowTitle, selected ? styles.rowTitleSelected : null]}
            numberOfLines={1}
          >
            {page.title}
          </Text>
          {page.parentId ? (
            <Text style={styles.rowHint} numberOfLines={1}>
              {page.parentId}
            </Text>
          ) : null}
        </View>
        {showActions ? (
          <View style={styles.rowActions}>
            <Pressable onPress={handleDeletePress} hitSlop={8} accessibilityRole="button">
              <Text style={styles.rowActionText}>×</Text>
            </Pressable>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
});

export function WorkPages(): ReactElement {
  const { t } = useTranslation();
  const projectKey = useSelectedWorkProjectKey();
  const { rows, isLoading, error } = useWorkPages(projectKey);
  const { upsertPage, deletePage } = useWorkMutations();
  const isCompact = useIsCompactFormFactor();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createParentId, setCreateParentId] = useState<string | null>(null);

  const createTitleRef = useRef<EditingTextInputHandle>(null);
  const createBodyRef = useRef<EditingTextInputHandle>(null);
  const draftTitleRef = useRef<EditingTextInputHandle>(null);
  const draftBodyRef = useRef<EditingTextInputHandle>(null);

  const selected = useMemo(() => rows.find((p) => p.id === selectedId) ?? null, [rows, selectedId]);

  useEffect(() => {
    if (selected) {
      setDraftTitle(selected.title);
      setDraftBody(selected.body ?? "");
      setDraftParentId(selected.parentId ?? null);
      setEditing(false);
      draftTitleRef.current?.replaceText(selected.title);
      draftBodyRef.current?.replaceText(selected.body ?? "");
    }
  }, [selected]);

  useEffect(() => {
    if (rows.length > 0 && !selectedId) {
      setSelectedId(rows[0].id);
    }
    if (selectedId && !rows.some((p) => p.id === selectedId)) {
      setSelectedId(rows[0]?.id ?? null);
    }
  }, [rows, selectedId]);

  const ordered = useMemo(() => {
    const byParent = new Map<string | null, WorkPage[]>();
    for (const p of rows) {
      const key = p.parentId ?? null;
      const arr = byParent.get(key);
      if (arr) arr.push(p);
      else byParent.set(key, [p]);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.title.localeCompare(b.title));
    }
    const out: Array<{ page: WorkPage; depth: number }> = [];
    const walk = (parentId: string | null, depth: number) => {
      const children = byParent.get(parentId) ?? [];
      for (const child of children) {
        out.push({ page: child, depth });
        walk(child.id, depth + 1);
      }
    };
    walk(null, 0);
    const seen = new Set(out.map((e) => e.page.id));
    for (const p of rows) if (!seen.has(p.id)) out.push({ page: p, depth: 0 });
    return out;
  }, [rows]);

  const handleCreate = useCallback(async () => {
    if (!projectKey || !createTitle.trim()) return;
    setSaving(true);
    try {
      await upsertPage({
        projectKey,
        page: {
          title: createTitle.trim(),
          body: createBody,
          ...(createParentId ? { parentId: createParentId } : { parentId: null }),
        },
      });
      setCreateTitle("");
      setCreateBody("");
      setCreateParentId(null);
      setShowCreate(false);
      createTitleRef.current?.replaceText("");
      createBodyRef.current?.replaceText("");
    } finally {
      setSaving(false);
    }
  }, [projectKey, createTitle, createBody, createParentId, upsertPage]);

  const handleSave = useCallback(async () => {
    if (!projectKey || !selected || !draftTitle.trim()) return;
    setSaving(true);
    try {
      await upsertPage({
        projectKey,
        page: {
          id: selected.id,
          title: draftTitle.trim(),
          body: draftBody,
          parentId: draftParentId,
        },
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [projectKey, selected, draftTitle, draftBody, draftParentId, upsertPage]);

  const handleDelete = useCallback(
    async (id: string) => {
      const target = rows.find((p) => p.id === id);
      const ok = await confirmDialog({
        title: t("work.pages.deleteConfirmTitle"),
        message: t("work.pages.deleteConfirmMessage", { title: target?.title ?? id }),
        destructive: true,
        confirmLabel: t("work.pages.delete"),
      });
      if (!ok) return;
      await deletePage({ id });
      if (selectedId === id) setSelectedId(null);
    },
    [rows, selectedId, deletePage, t],
  );

  const handleToggleCreate = useCallback(() => setShowCreate((v) => !v), []);
  const handleCloseCreate = useCallback(() => setShowCreate(false), []);
  const handleCancelEditing = useCallback(() => setEditing(false), []);
  const handleStartEditing = useCallback(() => setEditing(true), []);
  const handleDeleteSelected = useCallback(() => {
    if (selected) void handleDelete(selected.id);
  }, [selected, handleDelete]);

  const { isCapable: isCapableForGate, hostLabel: hostLabelForGate } =
    useWorkProjectHost(projectKey);

  if (!projectKey) {
    return (
      <View testID="work-pages" style={styles.center}>
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
      <View testID="work-pages" style={styles.center}>
        <LoadingSpinner color={styles.spinnerColor.color} />
        <Text style={styles.muted}>{t("work.states.loading")}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View testID="work-pages" style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  let detailContent: ReactElement;
  if (!selected) {
    detailContent = (
      <View style={styles.center}>
        <Text style={styles.muted}>{t("work.pages.selectPage")}</Text>
      </View>
    );
  } else if (editing) {
    detailContent = (
      <ScrollView contentContainerStyle={styles.editorContent}>
        <Text style={styles.label}>{t("work.pages.titlePlaceholder")}</Text>
        <EditingTextInput
          ref={draftTitleRef}
          initialValue={draftTitle}
          onChangeText={setDraftTitle}
          placeholder={t("work.pages.titlePlaceholder")}
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.input}
        />
        <Text style={styles.label}>{t("work.pages.preview")}</Text>
        <EditingTextInput
          ref={draftBodyRef}
          initialValue={draftBody}
          onChangeText={setDraftBody}
          placeholder={t("work.pages.bodyPlaceholder")}
          placeholderTextColor={styles.placeholderColor.color}
          style={[styles.input, styles.inputMultiline, styles.editorBody]}
          multiline
        />
        <View style={styles.editorActions}>
          <Button size="sm" variant="ghost" onPress={handleCancelEditing}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            size="sm"
            variant="default"
            onPress={handleSave}
            disabled={!draftTitle.trim() || saving}
            loading={saving}
          >
            {saving ? t("work.pages.saving") : t("work.pages.save")}
          </Button>
        </View>
      </ScrollView>
    );
  } else {
    detailContent = (
      <ScrollView contentContainerStyle={styles.viewerContent}>
        <View style={styles.viewerHeader}>
          <Text style={styles.viewerTitle}>{selected.title}</Text>
          <View style={styles.viewerHeaderActions}>
            <Button size="sm" variant="secondary" onPress={handleStartEditing}>
              {t("work.pages.rename")}
            </Button>
            <Button size="sm" variant="ghost" onPress={handleDeleteSelected}>
              {t("work.pages.delete")}
            </Button>
          </View>
        </View>
        <View style={styles.markdownWrap}>
          <MarkdownRenderer text={selected.body || ""} />
        </View>
        <View style={styles.editToggle}>
          <Button size="sm" variant="secondary" onPress={handleStartEditing}>
            {t("work.pages.save")}
          </Button>
        </View>
      </ScrollView>
    );
  }

  return (
    <View testID="work-pages" style={styles.root}>
      <View style={[styles.listPane, isCompact ? styles.listPaneCompact : null]}>
        <View style={styles.listHeader}>
          <Text style={styles.sectionTitle}>{t("work.pages.title")}</Text>
          <Button testID="work-page-new" size="sm" variant="secondary" onPress={handleToggleCreate}>
            {t("work.pages.newPage")}
          </Button>
        </View>

        {showCreate ? (
          <View style={styles.createCard}>
            <EditingTextInput
              ref={createTitleRef}
              initialValue={createTitle}
              onChangeText={setCreateTitle}
              placeholder={t("work.pages.titlePlaceholder")}
              placeholderTextColor={styles.placeholderColor.color}
              style={styles.input}
            />
            <EditingTextInput
              ref={createBodyRef}
              initialValue={createBody}
              onChangeText={setCreateBody}
              placeholder={t("work.pages.bodyPlaceholder")}
              placeholderTextColor={styles.placeholderColor.color}
              style={[styles.input, styles.inputMultiline]}
              multiline
            />
            <View style={styles.createActions}>
              <Button size="sm" variant="ghost" onPress={handleCloseCreate}>
                {t("common.actions.cancel")}
              </Button>
              <Button
                size="sm"
                variant="default"
                onPress={handleCreate}
                disabled={!createTitle.trim() || saving}
                loading={saving}
              >
                {saving ? t("work.pages.saving") : t("work.pages.create")}
              </Button>
            </View>
          </View>
        ) : null}

        {ordered.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.muted}>{t("work.pages.empty")}</Text>
            <Text style={styles.hint}>{t("work.pages.emptyHint")}</Text>
          </View>
        ) : (
          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {ordered.map(({ page, depth }) => (
              <WorkPageRow
                key={page.id}
                page={page}
                depth={depth}
                selected={page.id === selectedId}
                onSelect={setSelectedId}
                onDelete={handleDelete}
              />
            ))}
          </ScrollView>
        )}
      </View>

      <View
        style={[styles.detailPane, isCompact ? styles.detailPaneCompact : null]}
        testID="work-page-editor"
      >
        {detailContent}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: theme.colors.background,
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
    marginTop: theme.spacing[1],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  listPane: {
    width: 320,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  listPaneCompact: {
    width: "100%",
    borderRightWidth: 0,
  },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  createCard: {
    margin: theme.spacing[3],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
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
    minHeight: 80,
    textAlignVertical: "top",
  },
  createActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  empty: {
    alignItems: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[1],
  },
  listScroll: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing[2],
  },
  rowWrap: {
    borderRadius: theme.borderRadius.lg,
    marginHorizontal: theme.spacing[2],
  },
  rowWrapSelected: {
    backgroundColor: theme.colors.surface2,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  rowPressable: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingRight: theme.spacing[3],
    minHeight: 44,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowTitleSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  rowActions: {
    marginLeft: theme.spacing[2],
  },
  rowActionText: {
    color: theme.colors.foregroundMuted,
    fontSize: 16,
    paddingHorizontal: theme.spacing[1],
  },
  detailPane: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  detailPaneCompact: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  editorContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  editorBody: {
    minHeight: 220,
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  viewerContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  viewerTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  viewerHeaderActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  markdownWrap: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  editToggle: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
