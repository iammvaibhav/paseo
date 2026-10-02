import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  TicketAssignee,
  TicketBoard,
  TicketDetail,
  TicketPriority,
} from "@getpaseo/protocol/tickets/types";
import type { SelectFieldOption } from "@/components/ui/select-field";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { useToast } from "@/contexts/toast-context";
import { AssigneeAvatar } from "@/screens/tickets/components/assignee-avatar";
import { PriorityIcon } from "@/screens/tickets/components/priority-icon";
import { StatusIcon } from "@/screens/tickets/components/status-icon";
import { useInitiatives, useTicketList, useTicketMutations } from "@/tickets/queries";
import { ICON_SIZE } from "@/styles/theme";
import { PropertyPicker } from "./property-picker";
import {
  assigneeLabel,
  buildAssigneeOptions,
  buildColumnOptions,
  buildDueDatePresets,
  buildInitiativeOptions,
  buildPriorityOptions,
  formatDueDate,
  fromChoice,
  NO_VALUE,
  parseDueDate,
  priorityLabel,
  toChoice,
  type Choice,
} from "./ticket-fields";
import { useTicketAction } from "./use-ticket-action";

interface PropertiesProps {
  ticket: TicketDetail;
  board: TicketBoard | null;
}

/** The properties grid: every built-in field, each editable in place. */
export function TicketProperties({ ticket, board }: PropertiesProps): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.grid} testID="ticket-detail-properties">
      <PropertyRow label={t("tickets.detail.fields.status")}>
        <StatusProperty ticket={ticket} board={board} />
      </PropertyRow>
      <PropertyRow label={t("tickets.detail.fields.assignee")}>
        <AssigneeProperty ticket={ticket} />
      </PropertyRow>
      <PropertyRow label={t("tickets.detail.fields.priority")}>
        <PriorityProperty ticket={ticket} />
      </PropertyRow>
      <PropertyRow label={t("tickets.detail.fields.initiative")}>
        <InitiativeProperty ticket={ticket} />
      </PropertyRow>
      <PropertyRow label={t("tickets.detail.fields.parent")}>
        <ParentProperty ticket={ticket} />
      </PropertyRow>
      <PropertyRow label={t("tickets.detail.fields.dueDate")}>
        <DueDateProperty ticket={ticket} />
      </PropertyRow>
      {ticket.type ? (
        <PropertyRow label={t("tickets.detail.fields.type")}>
          <Text style={styles.staticValue}>{ticket.type}</Text>
        </PropertyRow>
      ) : null}
      <PropertyRow label={t("tickets.detail.fields.board")}>
        <Text style={styles.staticValue} numberOfLines={1}>
          {board ? `${board.name} · ${board.key}` : "—"}
        </Text>
      </PropertyRow>
    </View>
  );
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.control}>{children}</View>
    </View>
  );
}

function StatusProperty({ ticket, board }: PropertiesProps): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { pending, run: move } = useTicketAction(
    mutations.moveTicket,
    t("tickets.detail.errors.move"),
  );
  const columns = board?.columns;
  const options = useMemo(() => buildColumnOptions(columns ?? []), [columns]);
  const column = columns?.find((candidate) => candidate.id === ticket.columnId) ?? null;
  const leading = useMemo(
    () => (column ? <StatusIcon stateType={column.stateType} /> : null),
    [column],
  );
  const handleChange = useCallback(
    (columnId: string) => {
      if (columnId !== ticket.columnId) {
        void move({ ticketId: ticket.id, columnId });
      }
    },
    [move, ticket.columnId, ticket.id],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.status")}
      valueLabel={column?.name ?? "—"}
      leading={leading}
      options={options}
      value={ticket.columnId}
      onChange={handleChange}
      pending={pending}
      testID="ticket-detail-status"
    />
  );
}

function AssigneeProperty({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { pending, run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveAssignee"),
  );
  const options = useMemo(() => buildAssigneeOptions(t), [t]);
  const leading = useMemo(
    () => <AssigneeAvatar assignee={ticket.assignee} size={ICON_SIZE.lg} />,
    [ticket.assignee],
  );
  const handleChange = useCallback(
    (choice: Choice<TicketAssignee>) => {
      void update({ ticketId: ticket.id, assignee: fromChoice(choice) });
    },
    [ticket.id, update],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.assignee")}
      valueLabel={assigneeLabel(ticket.assignee, t)}
      isPlaceholder={ticket.assignee === null}
      leading={leading}
      options={options}
      value={toChoice(ticket.assignee)}
      onChange={handleChange}
      pending={pending}
      testID="ticket-detail-assignee"
    />
  );
}

function PriorityProperty({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { pending, run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.savePriority"),
  );
  const options = useMemo(() => buildPriorityOptions(t), [t]);
  const leading = useMemo(() => <PriorityIcon priority={ticket.priority} />, [ticket.priority]);
  const handleChange = useCallback(
    (choice: Choice<TicketPriority>) => {
      void update({ ticketId: ticket.id, priority: fromChoice(choice) });
    },
    [ticket.id, update],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.priority")}
      valueLabel={priorityLabel(ticket.priority, t)}
      isPlaceholder={ticket.priority === null}
      leading={leading}
      options={options}
      value={toChoice(ticket.priority)}
      onChange={handleChange}
      pending={pending}
      testID="ticket-detail-priority"
    />
  );
}

function InitiativeProperty({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { initiatives, isLoading } = useInitiatives(ticket.boardId);
  const { pending, run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveInitiative"),
  );
  const options = useMemo(() => buildInitiativeOptions(initiatives, t), [initiatives, t]);
  const current = initiatives.find((initiative) => initiative.id === ticket.initiativeId) ?? null;
  const handleChange = useCallback(
    (choice: Choice<string>) => {
      void update({ ticketId: ticket.id, initiativeId: fromChoice(choice) });
    },
    [ticket.id, update],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.initiative")}
      valueLabel={current?.title ?? t("tickets.detail.fields.noInitiative")}
      isPlaceholder={current === null}
      options={options}
      value={toChoice(ticket.initiativeId)}
      onChange={handleChange}
      searchable
      pending={pending || (isLoading && ticket.initiativeId !== null)}
      testID="ticket-detail-initiative"
    />
  );
}

function ParentProperty({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { tickets } = useTicketList(ticket.boardId);
  const { pending, run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveParent"),
  );
  // The hierarchy is one level deep: a ticket with sub-tasks has no parent,
  // and only a top-level ticket can be a parent.
  const hasSubtasks = ticket.subtasks.length > 0;
  const options = useMemo(() => {
    const candidates: SelectFieldOption<Choice<string>>[] = tickets
      .filter(
        (candidate) =>
          candidate.id !== ticket.id &&
          candidate.parentId === null &&
          candidate.archivedAt === null,
      )
      .map((candidate) => ({
        id: candidate.id,
        value: candidate.id,
        label: `${candidate.key}  ${candidate.title}`,
      }));
    candidates.push({ id: NO_VALUE, value: NO_VALUE, label: t("tickets.detail.fields.noParent") });
    return candidates;
  }, [t, ticket.id, tickets]);
  const parent = tickets.find((candidate) => candidate.id === ticket.parentId) ?? null;
  const handleChange = useCallback(
    (choice: Choice<string>) => {
      void update({ ticketId: ticket.id, parentId: fromChoice(choice) });
    },
    [ticket.id, update],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.parent")}
      valueLabel={parent ? parent.key : t("tickets.detail.fields.noParent")}
      isPlaceholder={parent === null}
      options={options}
      value={toChoice(ticket.parentId)}
      onChange={handleChange}
      searchable
      disabled={hasSubtasks}
      pending={pending}
      testID="ticket-detail-parent"
    />
  );
}

function DueDateProperty({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useTicketMutations();
  const { pending, run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveDueDate"),
  );
  const options = useMemo(() => {
    const presets: SelectFieldOption<Choice<string>>[] = buildDueDatePresets(t).map((preset) => ({
      id: preset.id,
      value: preset.value,
      label: preset.label,
      description: formatDueDate(preset.value),
    }));
    presets.push({ id: NO_VALUE, value: NO_VALUE, label: t("tickets.detail.dueDate.none") });
    return presets;
  }, [t]);
  const handleChange = useCallback(
    (choice: Choice<string>) => {
      void update({ ticketId: ticket.id, dueDate: fromChoice(choice) });
    },
    [ticket.id, update],
  );
  const handleCustomValue = useCallback(
    (text: string) => {
      const dueDate = parseDueDate(text);
      if (dueDate === null) {
        toast.error(t("tickets.detail.dueDate.invalid"));
        return;
      }
      void update({ ticketId: ticket.id, dueDate });
    },
    [t, ticket.id, toast, update],
  );
  return (
    <PropertyPicker
      label={t("tickets.detail.fields.dueDate")}
      valueLabel={ticket.dueDate ? formatDueDate(ticket.dueDate) : t("tickets.detail.dueDate.none")}
      isPlaceholder={ticket.dueDate === null}
      options={options}
      value={toChoice(ticket.dueDate)}
      onChange={handleChange}
      onCustomValue={handleCustomValue}
      customValuePrefix={t("tickets.detail.dueDate.customPrefix")}
      pending={pending}
      testID="ticket-detail-due-date"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: {
    gap: theme.spacing[1],
  },
  row: {
    minHeight: CONTROL_HEIGHTS.compact,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    width: theme.spacing[24],
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  control: {
    flex: 1,
    minWidth: 0,
    alignItems: "flex-start",
  },
  staticValue: {
    paddingHorizontal: theme.spacing[2],
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
}));
