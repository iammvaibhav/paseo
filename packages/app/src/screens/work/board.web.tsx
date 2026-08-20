import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import { ToastContext } from "@/contexts/toast-context";
import {
  isWorkColumnDroppable,
  resolveWorkMoveIntent,
  WORK_COLUMN_IDS,
  type WorkColumnId,
} from "@getpaseo/protocol/work/state";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Alert } from "@/components/ui/alert";
import type { WorkPriority } from "@getpaseo/protocol/work/types";
import type { WorkItem } from "@getpaseo/protocol/work/types";
import { openWorkItem as openWorkItemStore } from "@/screens/work/inspector-store";
import * as WorkData from "@/data/work";
import { useWorkProjectHost } from "@/data/work";

import { WorkCard } from "./card";
import { WorkColumn } from "./column";

const CREATE_PRIORITIES: WorkPriority[] = ["urgent", "high", "medium", "low", "none"];

interface ByColumn extends Record<WorkColumnId, WorkItem[]> {}
const EMPTY_ITEMS_ARRAY: readonly WorkItem[] = [];
const EMPTY_IDS_ARRAY: readonly string[] = [];
const EMPTY_BY_COLUMN: ByColumn = Object.freeze(
  WORK_COLUMN_IDS.reduce((acc, id) => {
    acc[id] = [];
    return acc;
  }, {} as ByColumn),
);

interface MoveArgs {
  itemId: string;
  targetColumn: WorkColumnId;
  prevSortOrder: number | null;
  nextSortOrder: number | null;
}

const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

const dropCollisionDetection: CollisionDetection = (args) => {
  // The dragged card's translated rect always contains the pointer; exclude it
  // so cross-column drops resolve to the target column/card instead of itself.
  const filtered: typeof args = {
    ...args,
    droppableContainers: args.droppableContainers.filter(({ id }) => id !== args.active.id),
  };
  const hits = pointerWithin(filtered);
  if (hits.length > 0) return hits;
  return closestCenter(filtered);
};

function findDraggedItem(
  byColumn: ByColumn,
  activeItemId: string,
): { dragged: WorkItem | null; sourceColumn: WorkColumnId | null } {
  for (const col of WORK_COLUMN_IDS) {
    const found = (byColumn[col] ?? []).find((it) => it.id === activeItemId);
    if (found) return { dragged: found, sourceColumn: col };
  }
  return { dragged: null, sourceColumn: null };
}

function computeSameColumnNeighbourOrders(
  colItems: WorkItem[],
  activeItemId: string,
  overId: string,
): { prev: number | null; next: number | null } | null {
  const oldIndex = colItems.findIndex((it) => it.id === activeItemId);
  const overIndex = colItems.findIndex((it) => it.id === overId);
  if (oldIndex === -1 || overIndex === -1) return null;
  const reordered = [...colItems];
  const [moved] = reordered.splice(oldIndex, 1);
  if (!moved) return null;
  reordered.splice(overIndex, 0, moved);
  const newIndex = reordered.findIndex((it) => it.id === activeItemId);
  const prev = newIndex > 0 ? (reordered[newIndex - 1]?.sortOrder ?? null) : null;
  const next =
    newIndex < reordered.length - 1 ? (reordered[newIndex + 1]?.sortOrder ?? null) : null;
  return { prev, next };
}

function computeNeighbourOrders(
  targetItems: WorkItem[],
  insertIndex: number,
): { prev: number | null; next: number | null } {
  const prev = insertIndex > 0 ? (targetItems[insertIndex - 1]?.sortOrder ?? null) : null;
  const next =
    insertIndex < targetItems.length ? (targetItems[insertIndex]?.sortOrder ?? null) : null;
  return { prev, next };
}

function resolveCrossColumnInsertIndex(targetItems: WorkItem[], overId: string): number {
  if (overId.startsWith("column:")) return targetItems.length;
  const idx = targetItems.findIndex((it) => it.id === overId);
  return idx !== -1 ? idx : targetItems.length;
}

function SortableWorkCard({
  item,
  onOpenDetail,
  onDispatch,
}: {
  item: WorkItem;
  onOpenDetail: (id: string) => void;
  onDispatch: (id: string) => void;
}): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.4 : 1,
    }),
    [transform, transition, isDragging],
  );

  const dragHandleProps = useMemo(() => ({ ...attributes, ...listeners }), [attributes, listeners]);

  return (
    <View ref={setNodeRef as never} style={inlineUnistylesStyle(style as never)}>
      <WorkCard
        item={item}
        onOpenDetail={onOpenDetail}
        onDispatch={onDispatch}
        dragHandleProps={dragHandleProps}
        setActivatorNodeRef={setNodeRef as never}
      />
    </View>
  );
}

interface WorkBoardProps {
  projectKey: string | null;
  itemsByColumn?: ByColumn;
  onMoveItem?: (args: MoveArgs) => Promise<void>;
  onDispatchItem?: (itemId: string) => Promise<void>;
  onOpenItem?: (itemId: string) => void;
}

function useWorkItemsByColumn(projectKey: string | null, injected?: ByColumn): ByColumn {
  const query = WorkData.useWorkItems(projectKey);
  const raw = injected ?? (query.byColumn as unknown as ByColumn | undefined);
  return useMemo(() => {
    if (!raw) return EMPTY_BY_COLUMN;
    const out = { ...raw } as ByColumn;
    for (const id of WORK_COLUMN_IDS) out[id] ??= EMPTY_ITEMS_ARRAY as WorkItem[];
    return out;
  }, [raw]);
}

function useMoveMutations(onMoveItem?: (args: MoveArgs) => Promise<void>) {
  const mutations = WorkData.useWorkMutations() as unknown as {
    moveItem?: (a: MoveArgs) => Promise<void>;
  };
  return useCallback(
    async (args: MoveArgs) => {
      if (onMoveItem) return onMoveItem(args);
      if (mutations.moveItem) return mutations.moveItem(args);
    },
    [mutations, onMoveItem],
  );
}

function useDispatchMutation(onDispatchItem?: (id: string) => Promise<void>) {
  const mutations = WorkData.useWorkMutations() as unknown as {
    dispatchItem?: (id: string) => Promise<void>;
  };
  return useCallback(
    async (id: string) => {
      if (onDispatchItem) return onDispatchItem(id);
      if (mutations.dispatchItem) return mutations.dispatchItem(id);
    },
    [mutations, onDispatchItem],
  );
}

function CreatePriorityOption({
  value,
  selected,
  onSelect,
}: {
  value: WorkPriority;
  selected: boolean;
  onSelect: (v: WorkPriority) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.priorityOption, selected ? styles.priorityOptionSelected : null]}
      testID={`work-item-new-priority-${value}`}
    >
      <Text
        style={[styles.priorityOptionText, selected ? styles.priorityOptionTextSelected : null]}
      >
        {t(`work.priority.${value}`)}
      </Text>
    </Pressable>
  );
}

function WorkItemCreateCard({
  projectKey,
  onCreated,
}: {
  projectKey: string | null;
  onCreated?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { createItem } = WorkData.useWorkMutations();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkPriority>("none");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<EditingTextInputHandle>(null);
  const descRef = useRef<EditingTextInputHandle>(null);
  const handlePriorityNoop = useCallback(() => {}, []);

  const handleToggle = useCallback(() => {
    setExpanded((v) => !v);
    setError(null);
  }, []);

  const handleCancel = useCallback(() => {
    setExpanded(false);
    setTitle("");
    setDescription("");
    setPriority("none");
    setError(null);
    titleRef.current?.replaceText("");
    descRef.current?.replaceText("");
  }, []);

  const handleCreate = useCallback(async () => {
    if (!projectKey || !title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createItem({
        projectKey,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(priority !== "none" ? { priority } : {}),
      });
      setTitle("");
      setDescription("");
      setPriority("none");
      setExpanded(false);
      titleRef.current?.replaceText("");
      descRef.current?.replaceText("");
      onCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [projectKey, title, description, priority, createItem, onCreated]);

  if (!expanded) {
    return (
      <Pressable
        testID="work-item-new"
        onPress={handleToggle}
        style={styles.createTrigger}
        accessibilityLabel={t("work.actions.newWorkItem")}
      >
        <Text style={styles.createTriggerText}>{t("work.actions.newWorkItem")}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.createCard} testID="work-item-new">
      <EditingTextInput
        ref={titleRef}
        initialValue={title}
        onChangeText={setTitle}
        placeholder={t("work.create.titlePlaceholder")}
        style={styles.createInput}
        testID="work-item-new-title"
      />
      <EditingTextInput
        ref={descRef}
        initialValue={description}
        onChangeText={setDescription}
        placeholder={t("work.create.descriptionPlaceholder")}
        style={[styles.createInput, styles.createInputMultiline]}
        testID="work-item-new-description"
        multiline
      />
      <View style={styles.priorityRow}>
        <Text style={styles.fieldLabel}>{t("work.create.priorityLabel")}</Text>
        <View style={styles.priorityOptions}>
          {CREATE_PRIORITIES.map((p) => (
            <CreatePriorityOption
              key={p}
              value={p}
              selected={priority === p}
              onSelect={setPriority}
            />
          ))}
        </View>
      </View>
      <View style={styles.createPriorityHidden}>
        <EditingTextInput
          initialValue={priority}
          onChangeText={handlePriorityNoop}
          style={styles.hiddenInput}
          testID="work-item-new-priority"
          editable={false}
        />
      </View>
      {error ? <Alert variant="error" title={error} /> : null}
      <View style={styles.createActions}>
        <Button variant="ghost" size="sm" onPress={handleCancel} testID="work-item-new-cancel">
          {t("work.create.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleCreate}
          disabled={!title.trim() || creating || !projectKey}
          loading={creating}
          testID="work-item-new-submit"
        >
          {creating ? t("work.create.creating") : t("work.create.create")}
        </Button>
      </View>
    </View>
  );
}

function BoardEmptyState({ projectKey }: { projectKey: string | null }): ReactElement {
  const { t } = useTranslation();
  const { isCapable, hostLabel } = useWorkProjectHost(projectKey);
  if (!projectKey) {
    return (
      <View style={styles.emptyCenter} testID="work-board-empty-no-project">
        <Text style={styles.muted}>{t("work.states.noProject")}</Text>
        <Text style={styles.hint}>{t("work.states.noProjectHint")}</Text>
      </View>
    );
  }
  if (isCapable === false) {
    return (
      <View testID="work-host-needs-update" style={styles.hostNeedsUpdate}>
        <Text style={styles.hostNeedsUpdateTitle}>{t("work.host.needsUpdateTitle")}</Text>
        <Text style={styles.hostNeedsUpdateHint}>
          {hostLabel
            ? t("work.host.needsUpdateDetail", { host: hostLabel })
            : t("work.host.needsUpdateDetailGeneric")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.emptyCenter} testID="work-board-empty">
      <Text style={styles.muted}>{t("work.column.empty")}</Text>
      <View style={styles.emptyCreateWrap}>
        <WorkItemCreateCard projectKey={projectKey} />
      </View>
    </View>
  );
}

function ColumnEmpty(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{t("work.column.empty")}</Text>
    </View>
  );
}

function BoardColumn({
  columnId,
  items,
  title,
  droppable,
  onOpenDetail,
  onDispatch,
  projectKey,
}: {
  columnId: WorkColumnId;
  items: WorkItem[];
  title: string;
  droppable: boolean;
  onOpenDetail: (id: string) => void;
  onDispatch: (id: string) => void;
  projectKey: string | null;
}): ReactElement {
  const ids = useMemo(
    () => (items.length === 0 ? (EMPTY_IDS_ARRAY as string[]) : items.map((it) => it.id)),
    [items],
  );
  const sortableItems = useMemo(
    () => (droppable ? ids : (EMPTY_IDS_ARRAY as string[])),
    [droppable, ids],
  );
  // The column body is a drop target so an empty column can receive a card.
  // Cards sort ahead of their column in `pointerWithin` (smaller rect), so
  // dropping on a card still resolves to the card, not the column.
  const { setNodeRef: columnDropRef } = useDroppable({
    id: `column:${columnId}`,
    disabled: !droppable,
  });
  const { isCapable } = useWorkProjectHost(projectKey);
  const showCreate = isCapable !== false;
  const isBacklog = columnId === "backlog";
  return (
    <View ref={columnDropRef as unknown as Ref<View>} style={styles.columnDropTarget}>
      <WorkColumn columnId={columnId} title={title} count={items.length} droppable={droppable}>
        <SortableContext
          id={`column:${columnId}`}
          items={sortableItems}
          strategy={verticalListSortingStrategy}
        >
          <View style={styles.columnBody}>
            {isBacklog && showCreate ? <WorkItemCreateCard projectKey={projectKey} /> : null}
            {items.map((item) => (
              <SortableWorkCard
                key={item.id}
                item={item}
                onOpenDetail={onOpenDetail}
                onDispatch={onDispatch}
              />
            ))}
            {items.length === 0 ? <ColumnEmpty /> : null}
          </View>
        </SortableContext>
      </WorkColumn>
    </View>
  );
}

export function WorkBoard({
  projectKey,
  itemsByColumn: injected,
  onMoveItem,
  onDispatchItem,
  onOpenItem,
}: WorkBoardProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToastMaybe();
  const { isCapable, hostLabel } = useWorkProjectHost(projectKey);
  const [activeId, setActiveId] = useState<string | null>(null);

  const byColumn = useWorkItemsByColumn(projectKey, injected);
  const moveItem = useMoveMutations(onMoveItem);
  const dispatchItem = useDispatchMutation(onDispatchItem);

  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: DRAG_ACTIVATION_CONFIG.movementDistance,
    },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: DRAG_ACTIVATION_CONFIG.touchHoldDelayMs,
      tolerance: DRAG_ACTIVATION_CONFIG.touchHoldTolerance,
    },
  });
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  const sensors = useSensors(mouseSensor, touchSensor, keyboardSensor);

  const activeItem = useMemo(() => {
    if (!activeId) return null;
    for (const col of WORK_COLUMN_IDS) {
      const found = (byColumn[col] ?? []).find((it) => it.id === activeId);
      if (found) return found;
    }
    return null;
  }, [activeId, byColumn]);

  const handleOpen = useCallback(
    (id: string) => {
      if (onOpenItem) return onOpenItem(id);
      openWorkItemStore(id);
    },
    [onOpenItem],
  );

  const handleDispatch = useCallback(
    async (id: string) => {
      await dispatchItem(id);
    },
    [dispatchItem],
  );

  const resolveTargetColumn = useCallback(
    (overId: string | null): WorkColumnId | null => {
      if (!overId) return null;
      if (overId.startsWith("column:")) return overId.slice(7) as WorkColumnId;
      for (const col of WORK_COLUMN_IDS) {
        if ((byColumn[col] ?? []).some((it) => it.id === overId)) return col;
      }
      return null;
    },
    [byColumn],
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(String(e.active.id));
  }, []);

  const handleDragCancel = useCallback(() => setActiveId(null), []);

  const handleSameColumnMove = useCallback(
    async (activeItemId: string, overId: string, targetColumn: WorkColumnId) => {
      const colItems = byColumn[targetColumn] ?? [];
      if (activeItemId === overId) return;
      const orders = computeSameColumnNeighbourOrders(colItems, activeItemId, overId);
      if (!orders) return;
      await moveItem({
        itemId: activeItemId,
        targetColumn,
        prevSortOrder: orders.prev,
        nextSortOrder: orders.next,
      });
    },
    [byColumn, moveItem],
  );

  const handleCrossColumnMove = useCallback(
    async (dragged: WorkItem, activeItemId: string, overId: string, targetColumn: WorkColumnId) => {
      const intent = resolveWorkMoveIntent({
        item: { lane: dragged.lane, closed: dragged.closed, agentId: dragged.agentId },
        targetColumn,
        agentBucket: dragged.bucket ?? null,
      });
      if (intent.kind === "reject") {
        toast?.show(intent.reason);
        return;
      }
      const targetItems = byColumn[targetColumn] ?? [];
      const insertIndex = resolveCrossColumnInsertIndex(targetItems, overId);
      const { prev, next } = computeNeighbourOrders(targetItems, insertIndex);
      await moveItem({
        itemId: activeItemId,
        targetColumn,
        prevSortOrder: prev,
        nextSortOrder: next,
      });
    },
    [byColumn, moveItem, toast],
  );

  const handleDragEnd = useCallback(
    async (e: DragEndEvent) => {
      const activeItemId = String(e.active.id);
      const overId = e.over ? String(e.over.id) : null;
      setActiveId(null);
      if (!overId) return;
      const targetColumn = resolveTargetColumn(overId);
      if (!targetColumn) return;
      const { dragged, sourceColumn } = findDraggedItem(byColumn, activeItemId);
      if (!dragged || !sourceColumn) return;
      if (!isWorkColumnDroppable(targetColumn)) {
        toast?.show(t("work.move.rejectedNeedsMe"));
        return;
      }
      if (targetColumn === sourceColumn) {
        await handleSameColumnMove(activeItemId, overId, targetColumn);
        return;
      }
      await handleCrossColumnMove(dragged, activeItemId, overId, targetColumn);
    },
    [byColumn, handleCrossColumnMove, handleSameColumnMove, resolveTargetColumn, t, toast],
  );

  if (isCapable === false) {
    return (
      <View testID="work-board" style={styles.root}>
        <View testID="work-host-needs-update" style={styles.hostNeedsUpdate}>
          <Text style={styles.hostNeedsUpdateTitle}>{t("work.host.needsUpdateTitle")}</Text>
          <Text style={styles.hostNeedsUpdateHint}>
            {hostLabel
              ? t("work.host.needsUpdateDetail", { host: hostLabel })
              : t("work.host.needsUpdateDetailGeneric")}
          </Text>
        </View>
      </View>
    );
  }

  const isEmptyBoard = WORK_COLUMN_IDS.every((col) => (byColumn[col] ?? []).length === 0);

  if (isEmptyBoard) {
    return (
      <View testID="work-board" style={styles.root}>
        <BoardEmptyState projectKey={projectKey} />
      </View>
    );
  }

  return (
    <View testID="work-board" style={styles.root}>
      <DndContext
        sensors={sensors}
        collisionDetection={dropCollisionDetection}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.columnsRow}
          style={styles.columnsScroll}
        >
          {WORK_COLUMN_IDS.map((columnId) => (
            <BoardColumn
              key={columnId}
              columnId={columnId}
              items={byColumn[columnId] ?? []}
              title={columnTitle(columnId, t)}
              droppable={isWorkColumnDroppable(columnId)}
              onOpenDetail={handleOpen}
              onDispatch={handleDispatch}
              projectKey={projectKey}
            />
          ))}
        </ScrollView>
        <DragOverlay dropAnimation={null}>
          {activeItem ? (
            <View style={styles.overlay}>
              <WorkCard item={activeItem} onOpenDetail={handleOpen} onDispatch={handleDispatch} />
            </View>
          ) : null}
        </DragOverlay>
      </DndContext>
    </View>
  );
}

function columnTitle(columnId: WorkColumnId, translate: (k: string) => string): string {
  const key = `work.column.${columnId}`;
  const v = translate(key);
  return v === key ? columnId : v;
}

function useToastMaybe(): { show: (msg: string) => void } | null {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return ctx as unknown as { show: (msg: string) => void };
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surfaceWorkspace,
  },
  columnsScroll: {
    flex: 1,
  },
  columnsRow: {
    flexDirection: "row",
    gap: 12,
    padding: 12,
    alignItems: "flex-start",
  },
  columnDropTarget: {
    flexShrink: 0,
  },
  columnBody: {
    minHeight: 80,
    paddingVertical: 6,
    gap: 2,
  },
  empty: {
    padding: 12,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  emptyCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[3],
  },
  emptyCreateWrap: {
    width: 320,
    maxWidth: "100%",
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  overlay: {
    width: 300,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  createTrigger: {
    marginHorizontal: 8,
    marginVertical: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    backgroundColor: theme.colors.surface1,
  },
  createTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  createCard: {
    marginHorizontal: 8,
    marginVertical: 6,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  createInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
  },
  createInputMultiline: {
    minHeight: 56,
    textAlignVertical: "top",
  },
  hiddenInput: {
    display: "none",
  },
  createPriorityHidden: {
    display: "none",
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  priorityRow: {
    gap: theme.spacing[1],
  },
  priorityOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  priorityOption: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
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
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  priorityOptionTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  createActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  hostNeedsUpdate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[2],
  },
  hostNeedsUpdateTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  hostNeedsUpdateHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
