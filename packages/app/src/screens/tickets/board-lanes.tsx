import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TicketColumn, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  BoardDndProvider,
  BoardLaneList,
  BoardScrollView,
  DraggableTicket,
  DroppableLane,
} from "./board-dnd";
import type { BoardDropTarget } from "./board-drag-state";
import type { BoardEdgeZone } from "./board-dnd.types";
import type { BoardLane } from "./board-model";
import { ColumnHeader } from "./components/column-header";
import { TicketCard } from "./components/ticket-card";

/** Matches the itsaplan column width, so a title wraps the same way in both. */
export const TICKET_LANE_WIDTH = 340;
const LANE_GAP = SPACING[3];
const BOARD_PADDING = SPACING[3];
// While a dragged card rests at a screen edge, the board pages one lane at this cadence.
const EDGE_SCROLL_INTERVAL_MS = 650;
// Theme-free on purpose: third-party and native scroll content containers drop
// or freeze theme-dependent styles (docs/unistyles.md).
const LANES_CONTENT_STYLE = {
  gap: LANE_GAP,
  paddingHorizontal: BOARD_PADDING,
  paddingBottom: BOARD_PADDING,
} as const;
const LANE_LIST_CONTENT_STYLE = { paddingBottom: SPACING[2] } as const;

export interface BoardLanesProps {
  lanes: readonly BoardLane[];
  columnById: ReadonlyMap<string, TicketColumn>;
  ticketById: ReadonlyMap<string, TicketSummary>;
  /** Set in the all-projects view: every card names its board. */
  boardNameById: ReadonlyMap<string, string> | null;
  onOpenTicket: (ticket: TicketSummary) => void;
  onDrop: (ticketId: string, target: BoardDropTarget) => void;
  /** Absent in the all-projects view: a lane there spans several boards. */
  onAddToLane: ((lane: BoardLane) => void) | null;
}

function useLaneWidth(): number {
  const isCompact = useIsCompactFormFactor();
  const { width } = useWindowDimensions();
  // On a phone the next lane peeks in from the right edge.
  return isCompact ? Math.min(TICKET_LANE_WIDTH, width - SPACING[12]) : TICKET_LANE_WIDTH;
}

function ignorePress() {}

export function BoardLanes({
  lanes,
  columnById,
  ticketById,
  boardNameById,
  onOpenTicket,
  onDrop,
  onAddToLane,
}: BoardLanesProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const laneWidth = useLaneWidth();
  const stride = laneWidth + LANE_GAP;
  const [height, setHeight] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const offsetRef = useRef(0);
  const maxOffsetRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const edgeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => clearInterval(edgeTimerRef.current ?? undefined), []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const layout = event.nativeEvent.layout;
    // A hidden retained panel reports zero; keep the last real height.
    if (layout.height > 0 && layout.width > 0) {
      setHeight(layout.height);
      viewportWidthRef.current = layout.width;
    }
  }, []);

  const handleContentSizeChange = useCallback((contentWidth: number) => {
    maxOffsetRef.current = Math.max(0, contentWidth - viewportWidthRef.current);
  }, []);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.x;
  }, []);

  const handleEdgeZoneChange = useCallback(
    (zone: BoardEdgeZone) => {
      clearInterval(edgeTimerRef.current ?? undefined);
      edgeTimerRef.current = null;
      if (zone === 0) {
        return;
      }
      function step() {
        const next = Math.min(maxOffsetRef.current, Math.max(0, offsetRef.current + zone * stride));
        offsetRef.current = next;
        scrollRef.current?.scrollTo({ x: next, animated: true });
      }
      step();
      edgeTimerRef.current = setInterval(step, EDGE_SCROLL_INTERVAL_MS);
    },
    [stride],
  );

  const renderOverlay = useCallback(
    (ticketId: string) => {
      const ticket = ticketById.get(ticketId);
      if (!ticket) {
        return null;
      }
      return (
        <View style={styles.overlayCard}>
          <TicketCard
            ticket={ticket}
            column={columnById.get(ticket.columnId) ?? null}
            boardName={boardNameById?.get(ticket.boardId) ?? null}
            onPress={ignorePress}
          />
        </View>
      );
    },
    [boardNameById, columnById, ticketById],
  );

  const laneHeight = Math.max(0, height - BOARD_PADDING);

  return (
    <View style={styles.viewport} onLayout={handleLayout}>
      <BoardDndProvider
        renderOverlay={renderOverlay}
        onDrop={onDrop}
        onEdgeZoneChange={handleEdgeZoneChange}
      >
        <BoardScrollView
          ref={scrollRef}
          horizontal
          style={styles.scroll}
          contentContainerStyle={LANES_CONTENT_STYLE}
          onScroll={handleScroll}
          onContentSizeChange={handleContentSizeChange}
          scrollEventThrottle={32}
          showsHorizontalScrollIndicator={!isCompact}
          snapToInterval={isCompact ? stride : undefined}
          decelerationRate={isCompact ? "fast" : "normal"}
          testID="tickets-board-lanes"
        >
          {height > 0
            ? lanes.map((lane) => (
                <BoardLaneColumn
                  key={lane.key}
                  lane={lane}
                  width={laneWidth}
                  height={laneHeight}
                  columnById={columnById}
                  boardNameById={boardNameById}
                  onOpenTicket={onOpenTicket}
                  onAddToLane={onAddToLane}
                />
              ))
            : null}
        </BoardScrollView>
      </BoardDndProvider>
    </View>
  );
}

interface BoardLaneColumnProps {
  lane: BoardLane;
  width: number;
  height: number;
  columnById: ReadonlyMap<string, TicketColumn>;
  boardNameById: ReadonlyMap<string, string> | null;
  onOpenTicket: (ticket: TicketSummary) => void;
  onAddToLane: ((lane: BoardLane) => void) | null;
}

function ticketKeyExtractor(ticket: TicketSummary): string {
  return ticket.id;
}

function CardGap(): ReactElement {
  return <View style={styles.cardGap} />;
}

const BoardLaneColumn = memo(function BoardLaneColumn({
  lane,
  width,
  height,
  columnById,
  boardNameById,
  onOpenTicket,
  onAddToLane,
}: BoardLaneColumnProps): ReactElement {
  const { t } = useTranslation();
  const add = useCallback(() => onAddToLane?.(lane), [lane, onAddToLane]);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TicketSummary>) => (
      <DraggableTicket ticketId={item.id} laneKey={lane.key}>
        <TicketCard
          ticket={item}
          column={columnById.get(item.columnId) ?? null}
          boardName={boardNameById?.get(item.boardId) ?? null}
          onPress={onOpenTicket}
        />
      </DraggableTicket>
    ),
    [boardNameById, columnById, lane.key, onOpenTicket],
  );
  const emptyLane = useMemo(
    () => <Text style={styles.emptyLane}>{t("tickets.board.emptyColumn")}</Text>,
    [t],
  );

  return (
    <View
      style={[styles.lane, inlineUnistylesStyle({ width, height })]}
      testID={`tickets-lane-${lane.name}`}
    >
      <ColumnHeader
        name={lane.name}
        stateType={lane.stateType}
        count={lane.tickets.length}
        onAdd={onAddToLane ? add : undefined}
      />
      <DroppableLane laneKey={lane.key} style={styles.laneBody}>
        <BoardLaneList
          data={lane.tickets}
          keyExtractor={ticketKeyExtractor}
          renderItem={renderItem}
          ItemSeparatorComponent={CardGap}
          ListEmptyComponent={emptyLane}
          contentContainerStyle={LANE_LIST_CONTENT_STYLE}
          showsVerticalScrollIndicator={false}
          initialNumToRender={8}
          windowSize={7}
        />
      </DroppableLane>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  viewport: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
  },
  lane: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  laneBody: {
    flex: 1,
    minHeight: 0,
    borderRadius: theme.borderRadius.md,
  },
  cardGap: {
    height: theme.spacing[2],
  },
  emptyLane: {
    paddingVertical: theme.spacing[4],
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  overlayCard: {
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.md,
  },
}));
