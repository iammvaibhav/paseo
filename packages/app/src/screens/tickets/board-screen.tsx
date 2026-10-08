import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Import, Plus, Target } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  TicketBoard,
  TicketColumn,
  TicketDetail,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import type { MenuTriggerState } from "@/components/ui/menu";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { ICON_SIZE } from "@/styles/theme";
import { useTicketBoards, useTicketList, useTicketMutations } from "@/tickets/queries";
import { ticketsQueryRoot } from "@/tickets/query-keys";
import { ALL_BOARDS_PARAM, buildTicketInitiativesRoute } from "@/tickets/routes";
import { useTicketsHost } from "@/tickets/use-tickets-host";
import { BoardLanes } from "./board-lanes";
import { BoardList } from "./board-list";
import { buildBoardLanes, type BoardLane } from "./board-model";
import { BoardSkeleton } from "./board-skeleton";
import { BoardPicker } from "./components/board-picker";
import { TicketsHostState, TicketsStateMessage } from "./components/host-state";
import { NewTicketDialog } from "./new-ticket-dialog";
import { TicketDetailPanel } from "./ticket-detail";
import { useBoardDrop } from "./use-board-drop";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedImport = withUnistyles(Import);
const ThemedTarget = withUnistyles(Target);
const TARGET_MENU_ICON = <ThemedTarget size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const IMPORT_MENU_ICON = <ThemedImport size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const TARGET_STATE_ICON = <ThemedTarget size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;

type BoardView = "board" | "list";

type NewTicketState = { visible: false } | { visible: true; columnId: string | undefined };

interface TicketRouteRef {
  ticketId?: string;
  key?: string;
}

const TICKET_ID_PATTERN = /^tkt_[0-9a-f]{16}$/;

/** `?ticket=` carries a key ("PASEO-45"); an id is accepted for links built from a bare ticket id. */
function parseTicketParam(value: string | undefined): TicketRouteRef | null {
  if (!value) {
    return null;
  }
  return TICKET_ID_PATTERN.test(value) ? { ticketId: value } : { key: value };
}

/**
 * `?board=` wins when it names a live board or "all". Without it, a single
 * board opens directly and several boards open the all-projects view.
 */
function resolveBoardId(param: string | undefined, boards: readonly TicketBoard[]): string | null {
  if (param && param !== ALL_BOARDS_PARAM && boards.some((board) => board.id === param)) {
    return param;
  }
  if (!param && boards.length === 1) {
    return boards[0]?.id ?? null;
  }
  return null;
}

function overflowTriggerStyle({ hovered, pressed, open }: MenuTriggerState) {
  return iconButtonChromeStyle({ size: "large", state: { hovered, pressed, open } });
}

export function TicketsBoardScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <TicketsBoardContent />;
}

function TicketsBoardContent(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const queryClient = useQueryClient();
  const host = useTicketsHost();
  const params = useLocalSearchParams<{ board?: string; ticket?: string }>();
  const mutations = useTicketMutations();
  const { boards, isLoading: boardsLoading, error: boardsError } = useTicketBoards();
  const activeBoards = useMemo(() => boards.filter((board) => board.archivedAt === null), [boards]);
  const boardId = resolveBoardId(params.board, activeBoards);
  const { tickets, isLoading: ticketsLoading, error: ticketsError } = useTicketList(boardId);
  const [view, setView] = useState<BoardView>("board");
  const [newTicket, setNewTicket] = useState<NewTicketState>({ visible: false });
  const [isImporting, setIsImporting] = useState(false);
  const ticketRef = useMemo(() => parseTicketParam(params.ticket), [params.ticket]);

  const lanes = useMemo(
    () => buildBoardLanes({ boards: activeBoards, boardId, tickets }),
    [activeBoards, boardId, tickets],
  );
  const columnById = useMemo(() => {
    const map = new Map<string, TicketColumn>();
    for (const board of boards) {
      for (const column of board.columns) map.set(column.id, column);
    }
    return map;
  }, [boards]);
  const ticketById = useMemo(
    () => new Map(tickets.map((ticket) => [ticket.id, ticket] as const)),
    [tickets],
  );
  const boardNameById = useMemo(
    () =>
      boardId === null ? new Map(boards.map((board) => [board.id, board.name] as const)) : null,
    [boardId, boards],
  );

  const viewOptions = useMemo<SegmentedControlOption<BoardView>[]>(
    () => [
      { value: "board", label: t("tickets.board.views.board"), testID: "tickets-view-board" },
      { value: "list", label: t("tickets.board.views.list"), testID: "tickets-view-list" },
    ],
    [t],
  );

  const selectBoard = useCallback((nextBoardId: string | null) => {
    router.setParams({ board: nextBoardId ?? ALL_BOARDS_PARAM });
  }, []);

  const openTicket = useCallback((ticket: TicketSummary) => {
    router.setParams({ ticket: ticket.key });
  }, []);

  const openTicketRef = useCallback(
    (ref: TicketRouteRef) => {
      const key = ref.key ?? (ref.ticketId ? ticketById.get(ref.ticketId)?.key : undefined);
      router.setParams({ ticket: key ?? ref.ticketId });
    },
    [ticketById],
  );

  const closeTicket = useCallback(() => {
    router.setParams({ ticket: undefined });
  }, []);

  const openNewTicket = useCallback(() => {
    setNewTicket({ visible: true, columnId: undefined });
  }, []);

  const addToLane = useCallback((lane: BoardLane) => {
    const column = lane.columnByBoardId.values().next().value;
    setNewTicket({ visible: true, columnId: column?.id });
  }, []);

  const closeNewTicket = useCallback(() => setNewTicket({ visible: false }), []);

  const handleCreated = useCallback((ticket: TicketDetail) => {
    setNewTicket({ visible: false });
    router.setParams({ ticket: ticket.key });
  }, []);

  const retry = useCallback(() => {
    if (host.serverId) {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryRoot(host.serverId) });
    }
  }, [host.serverId, queryClient]);

  const handleDrop = useBoardDrop({ lanes, ticketById, boardNameById });

  const importFromItsaplan = mutations.importFromItsaplan;
  const runImport = useCallback(() => {
    void importTickets();
    async function importTickets() {
      setIsImporting(true);
      toast.show(t("tickets.board.importing"), { variant: "info", durationMs: null });
      try {
        const report = await importFromItsaplan();
        const summary = t("tickets.board.importDone", {
          tickets: report.tickets,
          comments: report.comments,
          attachments: report.attachments,
          updated: report.updated,
        });
        if (report.errors.length > 0) {
          const errors = t("tickets.board.importDoneWithErrors", {
            count: report.errors.length,
            first: report.errors[0],
          });
          toast.show(`${summary} ${errors}`, { variant: "warning", durationMs: null });
        } else {
          toast.show(summary, { variant: "success", durationMs: 6_000 });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.show(t("tickets.board.importFailed", { message }), {
          variant: "error",
          durationMs: null,
        });
      } finally {
        setIsImporting(false);
      }
    }
  }, [importFromItsaplan, t, toast]);

  const openInitiatives = useCallback(() => router.push(buildTicketInitiativesRoute()), []);

  const isReady = host.status === "ready";
  const headerActions = useMemo(
    () =>
      isReady ? (
        <View style={styles.headerActions}>
          <Button
            variant="default"
            size="sm"
            leftIcon={Plus}
            onPress={openNewTicket}
            disabled={boardsLoading}
            testID="tickets-new"
          >
            {t("tickets.board.newTicket")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={overflowTriggerStyle}
              accessibilityRole="button"
              accessibilityLabel={t("tickets.board.moreActions")}
              testID="tickets-more"
            >
              <ThemedEllipsis
                size={iconButtonChromeGlyphSize("large")}
                uniProps={mutedIconColorMapping}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width={240} testID="tickets-more-menu">
              <DropdownMenuItem
                leading={TARGET_MENU_ICON}
                onSelect={openInitiatives}
                testID="tickets-open-initiatives"
              >
                {t("tickets.board.initiatives")}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={IMPORT_MENU_ICON}
                onSelect={runImport}
                disabled={isImporting}
                status={isImporting ? "pending" : "idle"}
                pendingLabel={t("tickets.board.importing")}
                testID="tickets-import-itsaplan"
              >
                {t("tickets.board.importFromItsaplan")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      ) : null,
    [boardsLoading, isImporting, isReady, openInitiatives, openNewTicket, runImport, t],
  );

  const allProjects = boardId === null;
  const addToLaneHandler = allProjects ? null : addToLane;

  function renderBody(): ReactElement {
    if (!isReady) {
      return <TicketsHostState host={host} />;
    }
    if (boardsLoading) {
      return <BoardSkeleton />;
    }
    if (boardsError) {
      return (
        <TicketsStateMessage
          testID="tickets-load-error"
          icon={null}
          title={t("tickets.board.states.loadFailed", { message: boardsError.message })}
        >
          <Button variant="outline" size="sm" onPress={retry}>
            {t("tickets.board.retry")}
          </Button>
        </TicketsStateMessage>
      );
    }
    if (activeBoards.length === 0) {
      return (
        <TicketsStateMessage
          testID="tickets-no-boards"
          icon={TARGET_STATE_ICON}
          title={t("tickets.board.states.noBoards.title")}
          description={t("tickets.board.states.noBoards.description")}
        >
          <Button variant="outline" size="sm" leftIcon={Plus} onPress={openNewTicket}>
            {t("tickets.board.newTicket")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={Import}
            onPress={runImport}
            loading={isImporting}
            testID="tickets-empty-import"
          >
            {isImporting ? t("tickets.board.importing") : t("tickets.board.importFromItsaplan")}
          </Button>
        </TicketsStateMessage>
      );
    }
    return (
      <View style={styles.boardArea}>
        <View style={styles.toolbar}>
          <BoardPicker boards={boards} value={boardId} onChange={selectBoard} />
          <SegmentedControl
            options={viewOptions}
            value={view}
            onValueChange={setView}
            size="xs"
            testID="tickets-view-toggle"
          />
        </View>
        {renderTickets()}
      </View>
    );
  }

  function renderTickets(): ReactElement {
    if (ticketsLoading) {
      return <BoardSkeleton />;
    }
    if (ticketsError) {
      return (
        <TicketsStateMessage
          testID="tickets-load-error"
          icon={null}
          title={t("tickets.board.states.loadFailed", { message: ticketsError.message })}
        >
          <Button variant="outline" size="sm" onPress={retry}>
            {t("tickets.board.retry")}
          </Button>
        </TicketsStateMessage>
      );
    }
    if (tickets.length === 0) {
      return (
        <TicketsStateMessage
          testID="tickets-empty-board"
          icon={null}
          title={t("tickets.board.states.emptyBoard.title")}
          description={t("tickets.board.states.emptyBoard.description")}
        >
          <Button variant="outline" size="sm" leftIcon={Plus} onPress={openNewTicket}>
            {t("tickets.board.newTicket")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={Import}
            onPress={runImport}
            loading={isImporting}
            testID="tickets-empty-import"
          >
            {isImporting ? t("tickets.board.importing") : t("tickets.board.importFromItsaplan")}
          </Button>
        </TicketsStateMessage>
      );
    }
    if (view === "list") {
      return (
        <BoardList
          lanes={lanes}
          columnById={columnById}
          boardNameById={boardNameById}
          onOpenTicket={openTicket}
          onAddToLane={addToLaneHandler}
        />
      );
    }
    return (
      <BoardLanes
        lanes={lanes}
        columnById={columnById}
        ticketById={ticketById}
        boardNameById={boardNameById}
        onOpenTicket={openTicket}
        onDrop={handleDrop}
        onAddToLane={addToLaneHandler}
      />
    );
  }

  const detailPanel =
    isReady && ticketRef ? (
      <TicketDetailPanel ticketRef={ticketRef} onClose={closeTicket} onOpenTicket={openTicketRef} />
    ) : null;

  return (
    <View style={styles.container}>
      <MenuHeader title={t("tickets.board.title")} rightContent={headerActions} />
      <View style={styles.body}>
        {renderBody()}
        {isCompact ? null : detailPanel}
      </View>
      {isCompact ? detailPanel : null}
      {isReady ? (
        <NewTicketDialog
          visible={newTicket.visible}
          boardId={boardId}
          defaultColumnId={newTicket.visible ? newTicket.columnId : undefined}
          onClose={closeNewTicket}
          onCreated={handleCreated}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  // Not clipped: the detail panel positions itself over the board's right edge.
  body: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  boardArea: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[2], md: theme.spacing[3] },
    paddingVertical: theme.spacing[2],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
