import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { TicketColumn, TicketDetail, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useTicketList, useTicketMutations } from "@/tickets/queries";
import type { TicketRef } from "@/tickets/query-keys";
import { ICON_SIZE } from "@/styles/theme";
import { DetailSection, SectionEmpty, SectionHeader } from "./section";
import { TicketPicker } from "./ticket-picker";
import { TicketRefRow } from "./ticket-ref-row";
import { useTicketAction } from "./use-ticket-action";

const ThemedPlus = withUnistyles(Plus);
const NEW_ICON = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;

interface SubtasksSectionProps {
  ticket: TicketDetail;
  columnById: ReadonlyMap<string, TicketColumn>;
  onOpenTicket: (ref: TicketRef) => void;
  onCreateSubtask: () => void;
}

/**
 * The ticket's place in the one-level hierarchy: the parent it hangs under,
 * or its sub-tasks with how many are done. The two never show together.
 */
export function SubtasksSection(props: SubtasksSectionProps): ReactElement {
  if (props.ticket.parentId !== null) {
    return <ParentBlock {...props} parentId={props.ticket.parentId} />;
  }
  return <SubtaskList {...props} />;
}

function useDetach() {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveParent"),
  );
  return useCallback(
    (child: TicketSummary) => {
      void update({ ticketId: child.id, parentId: null });
    },
    [update],
  );
}

function ParentBlock({
  ticket,
  parentId,
  columnById,
  onOpenTicket,
}: SubtasksSectionProps & { parentId: string }): ReactElement {
  const { t } = useTranslation();
  const { tickets } = useTicketList(ticket.boardId);
  const parent = tickets.find((candidate) => candidate.id === parentId) ?? null;
  const detach = useDetach();
  const handleOpen = useCallback(
    (target: TicketSummary) => onOpenTicket({ ticketId: target.id, key: target.key }),
    [onOpenTicket],
  );
  const handleDetach = useCallback(() => detach(ticket), [detach, ticket]);

  return (
    <DetailSection testID="ticket-detail-parent-section">
      <SectionHeader title={t("tickets.detail.subtasks.parent")} />
      {parent ? (
        <TicketRefRow
          ticket={parent}
          column={columnById.get(parent.columnId) ?? null}
          onOpen={handleOpen}
          onRemove={handleDetach}
          removeLabel={t("tickets.detail.subtasks.detachFromParent", { key: parent.key })}
        />
      ) : (
        <SectionEmpty>{t("common.loading")}</SectionEmpty>
      )}
    </DetailSection>
  );
}

function SubtaskList({
  ticket,
  columnById,
  onOpenTicket,
  onCreateSubtask,
}: SubtasksSectionProps): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { tickets } = useTicketList(ticket.boardId);
  const detach = useDetach();
  const { pending, run: update } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveParent"),
  );
  const candidates = useMemo(
    () =>
      tickets.filter(
        (candidate) =>
          candidate.id !== ticket.id &&
          candidate.parentId === null &&
          candidate.subtaskCount === 0 &&
          candidate.archivedAt === null,
      ),
    [ticket.id, tickets],
  );
  const handleOpen = useCallback(
    (target: TicketSummary) => onOpenTicket({ ticketId: target.id, key: target.key }),
    [onOpenTicket],
  );
  const handleAttach = useCallback(
    (child: TicketSummary) => {
      void update({ ticketId: child.id, parentId: ticket.id });
    },
    [ticket.id, update],
  );
  const doneCount = ticket.subtasks.filter((subtask) => {
    const stateType = columnById.get(subtask.columnId)?.stateType;
    return stateType === "completed" || stateType === "canceled";
  }).length;
  const tally = ticket.subtasks.length > 0 ? `${doneCount}/${ticket.subtasks.length}` : undefined;

  return (
    <DetailSection testID="ticket-detail-subtasks">
      <SectionHeader title={t("tickets.detail.subtasks.title")} tally={tally}>
        <View style={styles.actions}>
          <TicketPicker
            label={t("tickets.detail.subtasks.addExisting")}
            title={t("tickets.detail.subtasks.addExistingTitle")}
            candidates={candidates}
            onPick={handleAttach}
            pending={pending}
            testID="ticket-detail-subtasks-add-existing"
          />
          <Button
            variant="ghost"
            size="xs"
            leftIcon={NEW_ICON}
            onPress={onCreateSubtask}
            testID="ticket-detail-subtasks-new"
          >
            {t("tickets.detail.subtasks.new")}
          </Button>
        </View>
      </SectionHeader>
      {ticket.subtasks.length === 0 ? (
        <SectionEmpty>{t("tickets.detail.subtasks.empty")}</SectionEmpty>
      ) : (
        ticket.subtasks.map((subtask) => (
          <TicketRefRow
            key={subtask.id}
            ticket={subtask}
            column={columnById.get(subtask.columnId) ?? null}
            onOpen={handleOpen}
            onRemove={detach}
            removeLabel={t("tickets.detail.subtasks.detach", { key: subtask.key })}
          />
        ))
      )}
    </DetailSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
