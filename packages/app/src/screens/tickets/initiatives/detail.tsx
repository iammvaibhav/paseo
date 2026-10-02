import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { AlertCircle, Inbox, Plus, SearchX } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type {
  Initiative,
  InitiativeStatus,
  TicketColumn,
  TicketColumnStateType,
  TicketPriority,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { ICON_SIZE } from "@/styles/theme";
import {
  useInitiatives,
  useTicketBoards,
  useTicketList,
  type SaveInitiativeInput,
} from "@/tickets/queries";
import type { TicketRef } from "@/tickets/query-keys";
import { buildTicketInitiativesRoute } from "@/tickets/routes";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { useBoardDrop } from "../use-board-drop";
import { BoardLanes } from "../board-lanes";
import { buildBoardLanes, type BoardLane } from "../board-model";
import { TicketsStateMessage } from "../components/host-state";
import { NewTicketDialog } from "../new-ticket-dialog";
import { TicketDetailPanel } from "../ticket-detail";
import { InitiativeActionsMenu, InitiativePropertiesBar } from "./detail-header";
import type { InitiativeFormSnapshot } from "./form";
import { InitiativeFormSheet } from "./form-sheet";
import { InitiativeOverview } from "./overview";
import { countTicketsByState, selectActiveWork, type ActiveTicket } from "./ticket-groups";
import { useInitiativeActions } from "./use-initiative-actions";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedAlertCircle = withUnistyles(AlertCircle);
const ThemedSearchX = withUnistyles(SearchX);
const ThemedInbox = withUnistyles(Inbox);
const loadingIcon = <ThemedLoadingSpinner uniProps={mutedIconColorMapping} />;
const errorIcon = <ThemedAlertCircle size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;
const notFoundIcon = <ThemedSearchX size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;
const emptyIcon = <ThemedInbox size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;

type DetailTab = "overview" | "tickets";
type InitiativePatch = Pick<SaveInitiativeInput, "status" | "priority">;

interface NewTicketTarget {
  columnId: string | undefined;
}

interface EditSession {
  /** New per open, so the sheet builds a fresh form from the initiative as it is now. */
  key: number;
  visible: boolean;
  snapshot: InitiativeFormSnapshot;
}

/** Back to the list the user came from; a deep link has none, so it opens the list. */
export function leaveDetail(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(buildTicketInitiativesRoute());
}

/** One initiative, read from the all-boards initiative list of the board host. */
export function InitiativeDetail({
  serverId,
  initiativeId,
}: {
  serverId: string;
  initiativeId: string;
}): ReactElement {
  const { t } = useTranslation();
  const { initiatives, isLoading, error } = useInitiatives(null);
  const initiative = initiatives.find((candidate) => candidate.id === initiativeId) ?? null;

  if (initiative) {
    return <LoadedInitiativeDetail serverId={serverId} initiative={initiative} />;
  }

  let state: ReactElement;
  if (isLoading) {
    state = <TicketsStateMessage icon={loadingIcon} title={t("common.loading")} />;
  } else if (error) {
    state = (
      <TicketsStateMessage
        icon={errorIcon}
        title={t("tickets.initiatives.states.loadFailed", { message: error.message })}
        testID="initiative-load-failed"
      />
    );
  } else {
    state = (
      <TicketsStateMessage
        icon={notFoundIcon}
        title={t("tickets.initiatives.states.notFound.title")}
        description={t("tickets.initiatives.states.notFound.description")}
        testID="initiative-not-found"
      />
    );
  }
  return (
    <View style={styles.container}>
      <BackHeader onBack={leaveDetail} />
      {state}
    </View>
  );
}

/** Everything the two tabs read, derived once from the board and its ticket list. */
interface InitiativeTicketsView {
  boardName: string | null;
  tickets: TicketSummary[];
  lanes: BoardLane[];
  columnById: ReadonlyMap<string, TicketColumn>;
  ticketById: ReadonlyMap<string, TicketSummary>;
  stateCounts: Record<TicketColumnStateType, number>;
  stateByTicketId: ReadonlyMap<string, TicketColumnStateType>;
  activeWork: ActiveTicket[];
}

interface InitiativeTicketsResult {
  view: InitiativeTicketsView;
  isLoading: boolean;
  error: Error | null;
}

function useInitiativeTicketsView(initiative: Initiative): InitiativeTicketsResult {
  const { boards } = useTicketBoards();
  // The board host keeps every ticket of an initiative on the initiative's board.
  const ticketList = useTicketList(initiative.boardId);
  const view = useMemo((): InitiativeTicketsView => {
    const board = boards.find((candidate) => candidate.id === initiative.boardId) ?? null;
    const tickets = ticketList.tickets.filter((ticket) => ticket.initiativeId === initiative.id);
    const lanes = buildBoardLanes({ boards, boardId: initiative.boardId, tickets });
    const columnById = new Map((board?.columns ?? []).map((column) => [column.id, column]));
    const stateByTicketId = new Map<string, TicketColumnStateType>();
    for (const lane of lanes) {
      for (const ticket of lane.tickets) {
        stateByTicketId.set(ticket.id, lane.stateType);
      }
    }
    return {
      boardName: board?.name ?? null,
      tickets,
      lanes,
      columnById,
      ticketById: new Map(tickets.map((ticket) => [ticket.id, ticket])),
      stateCounts: countTicketsByState(lanes),
      stateByTicketId,
      activeWork: selectActiveWork(tickets),
    };
  }, [boards, initiative.boardId, initiative.id, ticketList.tickets]);
  return { view, isLoading: ticketList.isLoading, error: ticketList.error };
}

function LoadedInitiativeDetail({
  serverId,
  initiative,
}: {
  serverId: string;
  initiative: Initiative;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const actions = useInitiativeActions(serverId);
  const { boards } = useTicketBoards();
  const tickets = useInitiativeTicketsView(initiative);
  const { view } = tickets;

  const [tab, setTab] = useState<DetailTab>("overview");
  const [openTicket, setOpenTicket] = useState<TicketRef | null>(null);
  const [newTicket, setNewTicket] = useState<NewTicketTarget | null>(null);
  const [edit, setEdit] = useState<EditSession>(() => ({
    key: 0,
    visible: false,
    snapshot: { mode: "edit", initiative },
  }));

  const patch = useMutation({
    mutationFn: (change: InitiativePatch) =>
      actions.save({
        initiativeId: initiative.id,
        boardId: initiative.boardId,
        title: initiative.title,
        ...change,
      }),
    onError: (error) =>
      toast.error(t("tickets.initiatives.detail.updateFailed", { message: toErrorMessage(error) })),
  });
  const remove = useMutation({
    mutationFn: () => actions.remove(initiative.id),
    onSuccess: leaveDetail,
    onError: (error) =>
      toast.error(t("tickets.initiatives.detail.deleteFailed", { message: toErrorMessage(error) })),
  });

  // While a change is saved, the controls show the new value, not the stored one.
  const pendingChange = patch.isPending ? patch.variables : undefined;
  const shownStatus = pendingChange?.status ?? initiative.status;
  const shownPriority =
    pendingChange?.priority === undefined ? initiative.priority : pendingChange.priority;

  const { mutate: mutatePatch } = patch;
  const { mutate: mutateRemove } = remove;
  const changeStatus = useCallback(
    (status: InitiativeStatus) => mutatePatch({ status }),
    [mutatePatch],
  );
  const changePriority = useCallback(
    (priority: TicketPriority | null) => mutatePatch({ priority }),
    [mutatePatch],
  );
  const openEdit = useCallback(
    () =>
      setEdit((current) => ({
        key: current.key + 1,
        visible: true,
        snapshot: { mode: "edit", initiative },
      })),
    [initiative],
  );
  const closeEdit = useCallback(() => setEdit((current) => ({ ...current, visible: false })), []);
  const confirmDelete = useCallback(async () => {
    const message =
      initiative.ticketCount === 0
        ? t("tickets.initiatives.detail.deleteMessage", { title: initiative.title })
        : t("tickets.initiatives.detail.deleteMessageWithTickets", {
            title: initiative.title,
            count: initiative.ticketCount,
          });
    const confirmed = await confirmDialog({
      title: t("tickets.initiatives.detail.deleteTitle"),
      message,
      confirmLabel: t("tickets.initiatives.detail.deleteConfirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (confirmed) {
      mutateRemove();
    }
  }, [initiative.ticketCount, initiative.title, mutateRemove, t]);
  const handleDelete = useCallback(() => void confirmDelete(), [confirmDelete]);

  const openTicketDetail = useCallback(
    (ticket: TicketSummary) => setOpenTicket({ ticketId: ticket.id }),
    [],
  );
  const closeTicketDetail = useCallback(() => setOpenTicket(null), []);
  const addTicket = useCallback(() => setNewTicket({ columnId: undefined }), []);
  const addTicketToColumn = useCallback((columnId: string) => setNewTicket({ columnId }), []);
  const closeNewTicket = useCallback(() => setNewTicket(null), []);

  const tabOptions = useMemo<SegmentedControlOption<DetailTab>[]>(
    () => [
      {
        value: "overview",
        label: t("tickets.initiatives.detail.tabs.overview"),
        testID: "initiative-tab-overview",
      },
      {
        value: "tickets",
        label: `${t("tickets.initiatives.detail.tabs.tickets")} ${view.tickets.length}`,
        testID: "initiative-tab-tickets",
      },
    ],
    [t, view.tickets.length],
  );
  const headerActions = useMemo(
    () => (
      <InitiativeActionsMenu
        deleting={remove.isPending}
        onEdit={openEdit}
        onDelete={handleDelete}
      />
    ),
    [handleDelete, openEdit, remove.isPending],
  );

  return (
    <View style={styles.container}>
      <BackHeader title={initiative.title} rightContent={headerActions} onBack={leaveDetail} />
      <InitiativePropertiesBar
        initiative={initiative}
        status={shownStatus}
        priority={shownPriority}
        pending={patch.isPending}
        boardName={view.boardName}
        onStatusChange={changeStatus}
        onPriorityChange={changePriority}
        onEditDates={openEdit}
      />
      <View style={styles.tabBar}>
        <SegmentedControl
          options={tabOptions}
          value={tab}
          onValueChange={setTab}
          size="sm"
          testID="initiative-tabs"
        />
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={addTicket}
          testID="initiative-add-ticket"
        >
          {t("tickets.initiatives.detail.addTicket")}
        </Button>
      </View>
      {tab === "overview" ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.reading}>
            <InitiativeOverview
              initiative={initiative}
              stateCounts={view.stateCounts}
              stateByTicketId={view.stateByTicketId}
              activeWork={view.activeWork}
              onOpenTicket={openTicketDetail}
            />
          </View>
        </ScrollView>
      ) : (
        <InitiativeTicketsTab
          view={view}
          boardId={initiative.boardId}
          isLoading={tickets.isLoading}
          error={tickets.error}
          onOpenTicket={openTicketDetail}
          onAddTicket={addTicketToColumn}
        />
      )}

      <InitiativeFormSheet
        key={edit.key}
        serverId={serverId}
        visible={edit.visible}
        snapshot={edit.snapshot}
        boards={boards}
        onClose={closeEdit}
        onSaved={closeEdit}
      />
      <NewTicketDialog
        visible={newTicket !== null}
        boardId={initiative.boardId}
        defaultColumnId={newTicket?.columnId}
        initiativeId={initiative.id}
        onClose={closeNewTicket}
        onCreated={closeNewTicket}
      />
      {openTicket ? (
        <TicketDetailPanel
          ticketRef={openTicket}
          onClose={closeTicketDetail}
          onOpenTicket={setOpenTicket}
        />
      ) : null}
    </View>
  );
}

interface InitiativeTicketsTabProps {
  view: InitiativeTicketsView;
  boardId: string;
  isLoading: boolean;
  error: Error | null;
  onOpenTicket: (ticket: TicketSummary) => void;
  onAddTicket: (columnId: string) => void;
}

/** The initiative's tickets on the lanes of its board, with the board's drag and drop. */
function InitiativeTicketsTab({
  view,
  boardId,
  isLoading,
  error,
  onOpenTicket,
  onAddTicket,
}: InitiativeTicketsTabProps): ReactElement {
  const { t } = useTranslation();
  const handleDrop = useBoardDrop({
    lanes: view.lanes,
    ticketById: view.ticketById,
    boardNameById: null,
  });
  const addToLane = useCallback(
    (lane: BoardLane) => {
      const column = lane.columnByBoardId.get(boardId);
      if (column) {
        onAddTicket(column.id);
      }
    },
    [boardId, onAddTicket],
  );

  if (isLoading) {
    return <TicketsStateMessage icon={loadingIcon} title={t("common.loading")} />;
  }
  if (error) {
    return (
      <TicketsStateMessage
        icon={errorIcon}
        title={t("tickets.board.states.loadFailed", { message: error.message })}
      />
    );
  }
  if (view.tickets.length === 0) {
    return (
      <TicketsStateMessage
        icon={emptyIcon}
        title={t("tickets.initiatives.detail.noTickets")}
        testID="initiative-no-tickets"
      />
    );
  }
  return (
    <View style={styles.lanes} testID="initiative-tickets">
      <BoardLanes
        lanes={view.lanes}
        columnById={view.columnById}
        ticketById={view.ticketById}
        boardNameById={null}
        onOpenTicket={onOpenTicket}
        onDrop={handleDrop}
        onAddToLane={addToLane}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  tabBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[8],
  },
  reading: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
  },
  // The lanes carry their own horizontal padding, so only the gap under the tab bar is set here.
  lanes: {
    flex: 1,
    minHeight: 0,
    paddingTop: theme.spacing[4],
  },
}));
