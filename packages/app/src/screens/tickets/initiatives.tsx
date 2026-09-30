import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { AlertCircle, Plus, SquareKanban, Target } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Initiative, TicketBoard } from "@getpaseo/protocol/tickets/types";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";
import { useInitiatives, useTicketBoards } from "@/tickets/queries";
import { buildTicketInitiativeRoute, buildTicketsRoute } from "@/tickets/routes";
import { useTicketsHost } from "@/tickets/use-tickets-host";
import { BoardPicker } from "./components/board-picker";
import { TicketsHostState, TicketsStateMessage } from "./components/host-state";
import { InitiativeDetail, leaveDetail } from "./initiatives/detail";
import type { InitiativeFormBoard, InitiativeFormSnapshot } from "./initiatives/form";
import { InitiativeFormSheet } from "./initiatives/form-sheet";
import { InitiativesList } from "./initiatives/list";
import { groupInitiativesByStatus, type InitiativeSection } from "./initiatives/status";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedAlertCircle = withUnistyles(AlertCircle);
const ThemedSquareKanban = withUnistyles(SquareKanban);
const ThemedTarget = withUnistyles(Target);
const loadingIcon = <ThemedLoadingSpinner uniProps={mutedIconColorMapping} />;
const errorIcon = <ThemedAlertCircle size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;
const noBoardsIcon = <ThemedSquareKanban size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;
const emptyIcon = <ThemedTarget size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;

function openBoard(): void {
  router.push(buildTicketsRoute());
}

/** The initiatives of every board, or of one, grouped by status. */
export function InitiativesScreen(): ReactElement {
  const { t } = useTranslation();
  const host = useTicketsHost();
  const boardLink = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={SquareKanban}
        onPress={openBoard}
        testID="initiatives-open-board"
      >
        {t("tickets.initiatives.board")}
      </Button>
    ),
    [t],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("tickets.initiatives.title")} rightContent={boardLink} />
      {host.status === "ready" && host.serverId ? (
        <InitiativesBody serverId={host.serverId} />
      ) : (
        <TicketsHostState host={host} />
      )}
    </View>
  );
}

/** One initiative: its properties, overview and tickets. */
export function InitiativeDetailScreen({ initiativeId }: { initiativeId: string }): ReactElement {
  const host = useTicketsHost();
  if (host.status === "ready" && host.serverId) {
    return <InitiativeDetail serverId={host.serverId} initiativeId={initiativeId} />;
  }
  return (
    <View style={styles.container}>
      <BackHeader onBack={leaveDetail} />
      <TicketsHostState host={host} />
    </View>
  );
}

interface CreateSession {
  /** New per open, so the sheet builds a fresh form. */
  key: number;
  visible: boolean;
  snapshot: InitiativeFormSnapshot;
}

function defaultCreateBoard(
  boards: readonly TicketBoard[],
  boardId: string | null,
): InitiativeFormBoard | null {
  const board = boardId ? boards.find((candidate) => candidate.id === boardId) : undefined;
  const chosen = board ?? (boards.length === 1 ? boards[0] : undefined);
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}

function InitiativesBody({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const boardsQuery = useTicketBoards();
  const activeBoards = useMemo(
    () => boardsQuery.boards.filter((board) => board.archivedAt === null),
    [boardsQuery.boards],
  );
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  // A board archived or removed while selected falls back to every board.
  const boardId = activeBoards.some((board) => board.id === selectedBoardId)
    ? selectedBoardId
    : null;
  const initiativesQuery = useInitiatives(boardId);
  const [create, setCreate] = useState<CreateSession>({
    key: 0,
    visible: false,
    snapshot: { mode: "create", board: null },
  });

  const sections = useMemo(
    () => groupInitiativesByStatus(initiativesQuery.initiatives),
    [initiativesQuery.initiatives],
  );
  const boardNames = useMemo(() => {
    if (boardId !== null || activeBoards.length <= 1) {
      return null;
    }
    return new Map(activeBoards.map((board) => [board.id, board.name]));
  }, [activeBoards, boardId]);

  const openCreate = useCallback(
    () =>
      setCreate((current) => ({
        key: current.key + 1,
        visible: true,
        snapshot: { mode: "create", board: defaultCreateBoard(activeBoards, boardId) },
      })),
    [activeBoards, boardId],
  );
  const closeCreate = useCallback(
    () => setCreate((current) => ({ ...current, visible: false })),
    [],
  );
  const handleCreated = useCallback((initiative: Initiative) => {
    setCreate((current) => ({ ...current, visible: false }));
    router.push(buildTicketInitiativeRoute(initiative.id));
  }, []);
  const openInitiative = useCallback((initiative: Initiative) => {
    router.push(buildTicketInitiativeRoute(initiative.id));
  }, []);

  const isLoading = boardsQuery.isLoading || initiativesQuery.isLoading;
  const loadError = boardsQuery.error ?? initiativesQuery.error;
  const showToolbar = !isLoading && !loadError && activeBoards.length > 0;

  return (
    <View style={styles.body}>
      {showToolbar ? (
        <View style={styles.toolbar}>
          <View style={styles.toolbarRow}>
            <BoardPicker boards={activeBoards} value={boardId} onChange={setSelectedBoardId} />
            <Button
              variant="outline"
              size="sm"
              leftIcon={Plus}
              onPress={openCreate}
              testID="initiatives-new"
            >
              {t("tickets.initiatives.newInitiative")}
            </Button>
          </View>
        </View>
      ) : null}
      <InitiativesContent
        isLoading={isLoading}
        loadError={loadError}
        hasBoards={activeBoards.length > 0}
        isBoardFiltered={boardId !== null}
        sections={sections}
        boardNames={boardNames}
        onCreate={openCreate}
        onOpen={openInitiative}
      />
      <InitiativeFormSheet
        key={create.key}
        serverId={serverId}
        visible={create.visible}
        snapshot={create.snapshot}
        boards={activeBoards}
        onClose={closeCreate}
        onSaved={handleCreated}
      />
    </View>
  );
}

interface InitiativesContentProps {
  isLoading: boolean;
  loadError: Error | null;
  hasBoards: boolean;
  isBoardFiltered: boolean;
  sections: readonly InitiativeSection[];
  boardNames: ReadonlyMap<string, string> | null;
  onCreate: () => void;
  onOpen: (initiative: Initiative) => void;
}

function InitiativesContent({
  isLoading,
  loadError,
  hasBoards,
  isBoardFiltered,
  sections,
  boardNames,
  onCreate,
  onOpen,
}: InitiativesContentProps): ReactElement {
  const { t } = useTranslation();
  if (isLoading) {
    return <TicketsStateMessage icon={loadingIcon} title={t("common.loading")} />;
  }
  if (loadError) {
    return (
      <TicketsStateMessage
        icon={errorIcon}
        title={t("tickets.initiatives.states.loadFailed", { message: loadError.message })}
        testID="initiatives-load-failed"
      />
    );
  }
  if (!hasBoards) {
    return (
      <TicketsStateMessage
        icon={noBoardsIcon}
        title={t("tickets.initiatives.states.noBoards.title")}
        description={t("tickets.initiatives.states.noBoards.description")}
        testID="initiatives-no-boards"
      />
    );
  }
  if (sections.length === 0) {
    const title = isBoardFiltered
      ? t("tickets.initiatives.states.emptyBoard")
      : t("tickets.initiatives.states.empty.title");
    return (
      <TicketsStateMessage
        icon={emptyIcon}
        title={title}
        description={t("tickets.initiatives.states.empty.description")}
        testID="initiatives-empty"
      >
        <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="initiatives-empty-new">
          {t("tickets.initiatives.newInitiative")}
        </Button>
      </TicketsStateMessage>
    );
  }
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.reading}>
        <InitiativesList sections={sections} boardNames={boardNames} onOpen={onOpen} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  // Shares the list's centered column, so the picker sits on the cards' left rail.
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
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
}));
