import { useCallback, useMemo, useReducer, useState, type ReactElement } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import type {
  TicketAssignee,
  TicketBoard,
  TicketDetail,
  TicketPriority,
  TicketSummary,
} from "@getpaseo/protocol/tickets/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { Shortcut } from "@/components/ui/shortcut";
import { AssigneeAvatar } from "@/screens/tickets/components/assignee-avatar";
import { PriorityIcon } from "@/screens/tickets/components/priority-icon";
import { StatusIcon } from "@/screens/tickets/components/status-icon";
import {
  useInitiatives,
  useTicketBoards,
  useTicketList,
  useTicketMutations,
} from "@/tickets/queries";
import { ICON_SIZE } from "@/styles/theme";
import { PropertyPicker } from "./detail/property-picker";
import { isSubmitShortcut, SUBMIT_SHORTCUT_KEYS } from "./detail/submit-shortcut";
import {
  assigneeLabel,
  buildAssigneeOptions,
  buildBoardOptions,
  buildColumnOptions,
  buildInitiativeOptions,
  buildPriorityOptions,
  defaultColumnId,
  fromChoice,
  NO_VALUE,
  priorityLabel,
  toChoice,
  type Choice,
} from "./detail/ticket-fields";
import { TicketPicker } from "./detail/ticket-picker";

const ThemedX = withUnistyles(X);
const REMOVE_ICON = <ThemedX size={ICON_SIZE.xs} uniProps={mutedIconColorMapping} />;
const DESKTOP_WIDTH = 640;

export interface NewTicketDialogProps {
  visible: boolean;
  /** null shows a board picker. */
  boardId: string | null;
  defaultColumnId?: string;
  /** Creates a sub-task of this ticket. */
  parentId?: string;
  /** Preselects the initiative, e.g. when created from an initiative. */
  initiativeId?: string;
  onClose: () => void;
  onCreated: (ticket: TicketDetail) => void;
}

/**
 * The new-ticket form: title, description and a row of property pills.
 * ⌘/Ctrl+Enter creates. "Create and dispatch" also starts work through the
 * Commander. Every open starts from a fresh draft.
 */
export function NewTicketDialog(props: NewTicketDialogProps): ReactElement {
  const [openCount, setOpenCount] = useState(props.visible ? 1 : 0);
  const [wasVisible, setWasVisible] = useState(props.visible);
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible);
    if (props.visible) {
      setOpenCount((count) => count + 1);
    }
  }
  return <NewTicketSheet key={openCount} {...props} />;
}

interface Draft {
  boardId: string | null;
  title: string;
  description: string;
  columnId: string | null;
  assignee: TicketAssignee | null;
  priority: TicketPriority | null;
  initiativeId: string | null;
  parentId: string | null;
  blockedBy: readonly TicketSummary[];
}

type DraftAction =
  | { type: "board"; boardId: string }
  | { type: "title"; title: string }
  | { type: "description"; description: string }
  | { type: "column"; columnId: string }
  | { type: "assignee"; assignee: TicketAssignee | null }
  | { type: "priority"; priority: TicketPriority | null }
  | { type: "initiative"; initiativeId: string | null }
  | { type: "parent"; parentId: string | null }
  | { type: "addBlocker"; ticket: TicketSummary }
  | { type: "removeBlocker"; ticketId: string };

function reduceDraft(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case "board":
      // Columns, initiatives and the parent belong to one board. Blockers may cross boards.
      return {
        ...draft,
        boardId: action.boardId,
        columnId: null,
        initiativeId: null,
        parentId: null,
      };
    case "title":
      return { ...draft, title: action.title };
    case "description":
      return { ...draft, description: action.description };
    case "column":
      return { ...draft, columnId: action.columnId };
    case "assignee":
      return { ...draft, assignee: action.assignee };
    case "priority":
      return { ...draft, priority: action.priority };
    case "initiative":
      return { ...draft, initiativeId: action.initiativeId };
    case "parent":
      return { ...draft, parentId: action.parentId };
    case "addBlocker":
      return { ...draft, blockedBy: [...draft.blockedBy, action.ticket] };
    case "removeBlocker":
      return {
        ...draft,
        blockedBy: draft.blockedBy.filter((ticket) => ticket.id !== action.ticketId),
      };
  }
}

function initialDraft(props: NewTicketDialogProps): Draft {
  return {
    boardId: props.boardId,
    title: "",
    description: "",
    columnId: props.defaultColumnId ?? null,
    assignee: null,
    priority: null,
    initiativeId: props.initiativeId ?? null,
    parentId: props.parentId ?? null,
    blockedBy: [],
  };
}

type SubmitMode = "create" | "createAndDispatch";

function NewTicketSheet(props: NewTicketDialogProps): ReactElement {
  const { visible, onClose, onCreated } = props;
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { boards, isLoading: boardsLoading } = useTicketBoards();
  const [draft, dispatch] = useReducer(reduceDraft, props, initialDraft);
  const [submitting, setSubmitting] = useState<SubmitMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeBoards = useMemo(() => boards.filter((board) => board.archivedAt === null), [boards]);
  const board =
    activeBoards.find((candidate) => candidate.id === draft.boardId) ??
    (draft.boardId === null ? activeBoards[0] : undefined) ??
    null;
  const columnId = resolveColumnId(board, draft.columnId);
  const canSubmit = board !== null && columnId !== null && draft.title.trim() !== "";

  const submit = useCallback(
    async (mode: SubmitMode) => {
      if (!board || columnId === null || draft.title.trim() === "" || submitting) {
        return;
      }
      setSubmitting(mode);
      setError(null);
      try {
        const ticket = await mutations.createTicket({
          boardId: board.id,
          title: draft.title.trim(),
          description: draft.description,
          columnId,
          assignee: draft.assignee,
          priority: draft.priority,
          initiativeId: draft.initiativeId,
          parentId: draft.parentId,
          blockedByTicketIds: draft.blockedBy.map((blocker) => blocker.id),
        });
        if (mode === "createAndDispatch") {
          await mutations.dispatchTicket({ ticketId: ticket.id });
        }
        onCreated(ticket);
        onClose();
      } catch (caught) {
        if (!(caught instanceof Error)) {
          throw caught;
        }
        setError(caught.message);
      } finally {
        setSubmitting(null);
      }
    },
    [board, columnId, draft, mutations, onClose, onCreated, submitting],
  );
  const handleCreate = useCallback(() => void submit("create"), [submit]);
  const handleCreateAndDispatch = useCallback(() => void submit("createAndDispatch"), [submit]);
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (isSubmitShortcut(event)) {
        event.preventDefault();
        void submit("create");
      }
    },
    [submit],
  );
  const handleTitle = useCallback((title: string) => dispatch({ type: "title", title }), []);
  const handleDescription = useCallback(
    (description: string) => dispatch({ type: "description", description }),
    [],
  );

  const { tickets: boardTickets } = useTicketList(board?.id ?? null);
  const parent = boardTickets.find((ticket) => ticket.id === draft.parentId) ?? null;
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("tickets.create.title"),
      subtitle: parent ? t("tickets.create.subtaskOf", { key: parent.key }) : undefined,
    }),
    [parent, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Shortcut keys={SUBMIT_SHORTCUT_KEYS} />
        <View style={styles.footerButtons}>
          <Button
            variant="secondary"
            onPress={handleCreateAndDispatch}
            disabled={!canSubmit || submitting !== null}
            loading={submitting === "createAndDispatch"}
            testID="new-ticket-create-dispatch"
          >
            {t("tickets.create.createAndDispatch")}
          </Button>
          <Button
            variant="default"
            onPress={handleCreate}
            disabled={!canSubmit || submitting !== null}
            loading={submitting === "create"}
            testID="new-ticket-create"
          >
            {submitting === "create" ? t("tickets.create.creating") : t("tickets.create.create")}
          </Button>
        </View>
      </View>
    ),
    [canSubmit, handleCreate, handleCreateAndDispatch, submitting, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={DESKTOP_WIDTH}
      testID="new-ticket-dialog"
    >
      <View style={styles.form}>
        <AdaptiveTextInput
          initialValue=""
          onChangeText={handleTitle}
          onKeyPress={handleKeyPress}
          autoFocus
          placeholder={t("tickets.create.titlePlaceholder")}
          accessibilityLabel={t("tickets.create.titleLabel")}
          style={styles.titleInput}
          testID="new-ticket-title"
        />
        <FormTextInput
          initialValue=""
          onChangeText={handleDescription}
          onKeyPress={handleKeyPress}
          multiline
          placeholder={t("tickets.create.descriptionPlaceholder")}
          accessibilityLabel={t("tickets.create.descriptionLabel")}
          style={styles.descriptionInput}
          testID="new-ticket-description"
        />
        {board ? (
          <DraftPills
            draft={draft}
            board={board}
            boards={activeBoards}
            showBoardPicker={props.boardId === null}
            columnId={columnId}
            boardTickets={boardTickets}
            dispatch={dispatch}
          />
        ) : (
          <Text style={styles.hint}>
            {boardsLoading ? t("common.loading") : t("tickets.create.noBoards")}
          </Text>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function resolveColumnId(board: TicketBoard | null, chosen: string | null): string | null {
  if (!board) {
    return null;
  }
  const isOnBoard = board.columns.some((column) => column.id === chosen);
  return isOnBoard ? chosen : defaultColumnId(board);
}

interface DraftPillsProps {
  draft: Draft;
  board: TicketBoard;
  boards: readonly TicketBoard[];
  showBoardPicker: boolean;
  columnId: string | null;
  boardTickets: readonly TicketSummary[];
  dispatch: (action: DraftAction) => void;
}

function DraftPills({
  draft,
  board,
  boards,
  showBoardPicker,
  columnId,
  boardTickets,
  dispatch,
}: DraftPillsProps): ReactElement {
  return (
    <View style={styles.pills}>
      {showBoardPicker ? <BoardPill board={board} boards={boards} dispatch={dispatch} /> : null}
      <ColumnPill board={board} columnId={columnId} dispatch={dispatch} />
      <AssigneePill assignee={draft.assignee} dispatch={dispatch} />
      <PriorityPill priority={draft.priority} dispatch={dispatch} />
      <InitiativePill boardId={board.id} initiativeId={draft.initiativeId} dispatch={dispatch} />
      <ParentPill parentId={draft.parentId} boardTickets={boardTickets} dispatch={dispatch} />
      <BlockersPill blockedBy={draft.blockedBy} dispatch={dispatch} />
    </View>
  );
}

function BoardPill({
  board,
  boards,
  dispatch,
}: {
  board: TicketBoard;
  boards: readonly TicketBoard[];
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo(() => buildBoardOptions(boards), [boards]);
  const handleChange = useCallback(
    (boardId: string) => dispatch({ type: "board", boardId }),
    [dispatch],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.board")}
      valueLabel={board.name}
      options={options}
      value={board.id}
      onChange={handleChange}
      searchable
      appearance="pill"
      testID="new-ticket-board"
    />
  );
}

function ColumnPill({
  board,
  columnId,
  dispatch,
}: {
  board: TicketBoard;
  columnId: string | null;
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo(() => buildColumnOptions(board.columns), [board.columns]);
  const column = board.columns.find((candidate) => candidate.id === columnId) ?? null;
  const leading = useMemo(
    () => (column ? <StatusIcon stateType={column.stateType} /> : null),
    [column],
  );
  const handleChange = useCallback(
    (nextColumnId: string) => dispatch({ type: "column", columnId: nextColumnId }),
    [dispatch],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.status")}
      valueLabel={column?.name ?? "—"}
      leading={leading}
      options={options}
      value={columnId}
      onChange={handleChange}
      appearance="pill"
      testID="new-ticket-column"
    />
  );
}

function AssigneePill({
  assignee,
  dispatch,
}: {
  assignee: TicketAssignee | null;
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo(() => buildAssigneeOptions(t), [t]);
  const leading = useMemo(
    () => <AssigneeAvatar assignee={assignee} size={ICON_SIZE.lg} />,
    [assignee],
  );
  const handleChange = useCallback(
    (choice: Choice<TicketAssignee>) =>
      dispatch({ type: "assignee", assignee: fromChoice(choice) }),
    [dispatch],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.assignee")}
      valueLabel={assigneeLabel(assignee, t)}
      isPlaceholder={assignee === null}
      leading={leading}
      options={options}
      value={toChoice(assignee)}
      onChange={handleChange}
      appearance="pill"
      testID="new-ticket-assignee"
    />
  );
}

function PriorityPill({
  priority,
  dispatch,
}: {
  priority: TicketPriority | null;
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo(() => buildPriorityOptions(t), [t]);
  const leading = useMemo(() => <PriorityIcon priority={priority} />, [priority]);
  const handleChange = useCallback(
    (choice: Choice<TicketPriority>) =>
      dispatch({ type: "priority", priority: fromChoice(choice) }),
    [dispatch],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.priority")}
      valueLabel={priorityLabel(priority, t)}
      isPlaceholder={priority === null}
      leading={leading}
      options={options}
      value={toChoice(priority)}
      onChange={handleChange}
      appearance="pill"
      testID="new-ticket-priority"
    />
  );
}

function InitiativePill({
  boardId,
  initiativeId,
  dispatch,
}: {
  boardId: string;
  initiativeId: string | null;
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { initiatives } = useInitiatives(boardId);
  const options = useMemo(() => buildInitiativeOptions(initiatives, t), [initiatives, t]);
  const current = initiatives.find((initiative) => initiative.id === initiativeId) ?? null;
  const handleChange = useCallback(
    (choice: Choice<string>) => dispatch({ type: "initiative", initiativeId: fromChoice(choice) }),
    [dispatch],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.initiative")}
      valueLabel={current?.title ?? t("tickets.detail.fields.initiative")}
      isPlaceholder={current === null}
      options={options}
      value={toChoice(initiativeId)}
      onChange={handleChange}
      searchable
      appearance="pill"
      testID="new-ticket-initiative"
    />
  );
}

function ParentPill({
  parentId,
  boardTickets,
  dispatch,
}: {
  parentId: string | null;
  boardTickets: readonly TicketSummary[];
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo(() => {
    const topLevel = boardTickets
      .filter((ticket) => ticket.parentId === null && ticket.archivedAt === null)
      .map((ticket) => ({
        id: ticket.id,
        value: ticket.id,
        label: `${ticket.key}  ${ticket.title}`,
      }));
    return [
      ...topLevel,
      { id: NO_VALUE, value: NO_VALUE, label: t("tickets.detail.fields.noParent") },
    ];
  }, [boardTickets, t]);
  const parent = boardTickets.find((ticket) => ticket.id === parentId) ?? null;
  const handleChange = useCallback(
    (choice: string) => dispatch({ type: "parent", parentId: fromChoice(choice) }),
    [dispatch],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.parent")}
      valueLabel={parent ? parent.key : t("tickets.detail.fields.parent")}
      isPlaceholder={parent === null}
      options={options}
      value={toChoice(parentId)}
      onChange={handleChange}
      searchable
      appearance="pill"
      testID="new-ticket-parent"
    />
  );
}

function BlockersPill({
  blockedBy,
  dispatch,
}: {
  blockedBy: readonly TicketSummary[];
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { tickets } = useTicketList(null);
  const candidates = useMemo(() => {
    const chosen = new Set(blockedBy.map((ticket) => ticket.id));
    return tickets.filter((ticket) => !chosen.has(ticket.id) && ticket.archivedAt === null);
  }, [blockedBy, tickets]);
  const handleAdd = useCallback(
    (ticket: TicketSummary) => dispatch({ type: "addBlocker", ticket }),
    [dispatch],
  );
  return (
    <>
      {blockedBy.map((ticket) => (
        <BlockerChip key={ticket.id} ticket={ticket} dispatch={dispatch} />
      ))}
      <TicketPicker
        label={t("tickets.create.blockedBy")}
        title={t("tickets.create.blockedByTitle")}
        candidates={candidates}
        onPick={handleAdd}
        testID="new-ticket-blocked-by"
      />
    </>
  );
}

function BlockerChip({
  ticket,
  dispatch,
}: {
  ticket: TicketSummary;
  dispatch: (action: DraftAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleRemove = useCallback(
    () => dispatch({ type: "removeBlocker", ticketId: ticket.id }),
    [dispatch, ticket.id],
  );
  return (
    <Button
      variant="outline"
      size="xs"
      trailing={REMOVE_ICON}
      onPress={handleRemove}
      accessibilityLabel={t("tickets.create.removeBlocker", { key: ticket.key })}
      testID={`new-ticket-blocker-${ticket.key}`}
    >
      {t("tickets.create.blockedByChip", { key: ticket.key })}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[3],
  },
  titleInput: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: 0,
  },
  descriptionInput: {
    minHeight: theme.spacing[32],
    textAlignVertical: "top",
  },
  pills: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[300],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  footerButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
}));
