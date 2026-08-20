import { memo, useCallback, useContext, useId, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  NestableDraggableFlatList,
  NestableScrollContainer,
} from "react-native-draggable-flatlist";
import { ToastContext } from "@/contexts/toast-context";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useFileExplorerCloseGestureRef } from "@/mobile-panels/gestures";
import {
  isWorkColumnDroppable,
  WORK_COLUMN_IDS,
  type WorkColumnId,
} from "@getpaseo/protocol/work/state";
import type { WorkItem } from "@getpaseo/protocol/work/types";
import { openWorkItem as openWorkItemStore } from "@/screens/work/inspector-store";
import * as WorkData from "@/data/work";

import { WorkCard } from "./card";
import { WorkColumn } from "./column";

interface ByColumn extends Record<WorkColumnId, WorkItem[]> {}

interface MoveArgs {
  itemId: string;
  targetColumn: WorkColumnId;
  prevSortOrder: number | null;
  nextSortOrder: number | null;
}

function useWorkItemsByColumn(projectKey: string | null, injected?: ByColumn): ByColumn {
  const fallback = useMemo(() => ({}) as ByColumn, []);
  const query = WorkData.useWorkItems(projectKey);
  const raw = injected ?? (query.byColumn as unknown as ByColumn | undefined) ?? fallback;
  return useMemo(() => {
    const out = { ...raw } as ByColumn;
    for (const id of WORK_COLUMN_IDS) out[id] ??= [];
    return out;
  }, [raw]);
}

const PressableCard = memo(function PressableCard({
  item,
  onOpenDetail,
  onDispatch,
  onDrag,
  enabled,
}: {
  item: WorkItem;
  onOpenDetail: (id: string) => void;
  onDispatch: (id: string) => void;
  onDrag: () => void;
  enabled: boolean;
}): ReactElement {
  const handleLongPress = useCallback(() => {
    if (enabled) onDrag();
  }, [enabled, onDrag]);
  return (
    <Pressable onLongPress={handleLongPress} delayLongPress={180}>
      <WorkCard item={item} onOpenDetail={onOpenDetail} onDispatch={onDispatch} />
    </Pressable>
  );
});

function computeNeighbourSortOrders(
  data: WorkItem[],
  to: number,
): { prev: number | null; next: number | null } {
  const prev = to > 0 ? (data[to - 1]?.sortOrder ?? null) : null;
  const next = to < data.length - 1 ? (data[to + 1]?.sortOrder ?? null) : null;
  return { prev, next };
}

const EMPTY_COLUMN = <ColumnEmpty />;

function ColumnEmpty(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{t("work.column.empty")}</Text>
    </View>
  );
}

function NativeColumn({
  columnId,
  title,
  items,
  onOpenItem,
  onDispatchItem,
  onMoveItem,
}: {
  columnId: WorkColumnId;
  title: string;
  items: WorkItem[];
  onOpenItem?: (id: string) => void;
  onDispatchItem?: (itemId: string) => Promise<void>;
  onMoveItem?: (args: MoveArgs) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToastMaybe();
  const droppable = isWorkColumnDroppable(columnId);

  const mutations = WorkData.useWorkMutations() as unknown as {
    moveItem?: (a: MoveArgs) => Promise<void>;
    dispatchItem?: (id: string) => Promise<void>;
  };

  const handleOpen = useCallback(
    (id: string) => {
      if (onOpenItem) return onOpenItem(id);
      openWorkItemStore(id);
    },
    [onOpenItem],
  );

  const handleDispatch = useCallback(
    async (id: string) => {
      if (onDispatchItem) return onDispatchItem(id);
      if (mutations.dispatchItem) return mutations.dispatchItem(id);
    },
    [mutations, onDispatchItem],
  );

  const handleDragEnd = useCallback(
    async ({ data, from, to }: { data: WorkItem[]; from: number; to: number }) => {
      if (!droppable) {
        toast?.show(t("work.move.rejectedNeedsMe"));
        return;
      }
      if (from === to) return;
      const moved = data[to];
      if (!moved) return;
      const { prev, next } = computeNeighbourSortOrders(data, to);
      if (onMoveItem) {
        await onMoveItem({
          itemId: moved.id,
          targetColumn: columnId,
          prevSortOrder: prev,
          nextSortOrder: next,
        });
        return;
      }
      if (mutations.moveItem) {
        await mutations.moveItem({
          itemId: moved.id,
          targetColumn: columnId,
          prevSortOrder: prev,
          nextSortOrder: next,
        });
      }
    },
    [columnId, droppable, mutations, onMoveItem, t, toast],
  );

  const keyExtractor = useCallback((it: WorkItem) => it.id, []);

  const renderItem = useCallback(
    ({ item, drag, isActive }: { item: WorkItem; drag: () => void; isActive: boolean }) => (
      <View style={isActive ? styles.dragging : null}>
        <PressableCard
          item={item}
          onOpenDetail={handleOpen}
          onDispatch={handleDispatch}
          onDrag={drag}
          enabled={droppable}
        />
      </View>
    ),
    [droppable, handleDispatch, handleOpen],
  );

  return (
    <WorkColumn columnId={columnId} title={title} count={items.length} droppable={droppable}>
      <NestableDraggableFlatList
        data={items}
        keyExtractor={keyExtractor}
        onDragEnd={handleDragEnd}
        activationDistance={6}
        renderItem={renderItem}
        ListEmptyComponent={EMPTY_COLUMN}
      />
    </WorkColumn>
  );
}

export function WorkBoard({
  projectKey,
  itemsByColumn: injected,
  onMoveItem,
  onDispatchItem,
  onOpenItem,
}: {
  projectKey: string | null;
  itemsByColumn?: ByColumn;
  onMoveItem?: (args: MoveArgs) => Promise<void>;
  onDispatchItem?: (itemId: string) => Promise<void>;
  onOpenItem?: (itemId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const horizontalScroll = useHorizontalScrollOptional();
  const closeGestureRef = useFileExplorerCloseGestureRef();
  const scrollId = useId();

  const byColumn = useWorkItemsByColumn(projectKey, injected);

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      horizontalScroll?.registerScrollOffset(scrollId, e.nativeEvent.contentOffset.x);
    },
    [horizontalScroll, scrollId],
  );

  const handleTouchStart = useCallback(() => {
    horizontalScroll?.beginHorizontalGesture(0);
  }, [horizontalScroll]);

  const handleTouchEnd = useCallback(() => {
    horizontalScroll?.endHorizontalGesture();
  }, [horizontalScroll]);

  const nativeScrollGestureProps = useMemo(
    () =>
      closeGestureRef.current ? ({ simultaneousHandlers: closeGestureRef } as object) : undefined,
    [closeGestureRef],
  );

  return (
    <View testID="work-board" style={styles.root}>
      <NestableScrollContainer
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.columnsRow}
        style={styles.columnsScroll}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        {...(nativeScrollGestureProps ?? {})}
      >
        {WORK_COLUMN_IDS.map((columnId) => (
          <NativeColumn
            key={columnId}
            columnId={columnId}
            title={columnTitle(columnId, t)}
            items={byColumn[columnId] ?? []}
            onOpenItem={onOpenItem}
            onDispatchItem={onDispatchItem}
            onMoveItem={onMoveItem}
          />
        ))}
      </NestableScrollContainer>
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

const styles = StyleSheet.create((theme) => ({
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
  dragging: {
    opacity: 0.6,
  },
  empty: {
    padding: 12,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
