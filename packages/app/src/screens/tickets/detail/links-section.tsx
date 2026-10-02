import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { TicketColumn, TicketDetail, TicketSummary } from "@getpaseo/protocol/tickets/types";
import { useTicketList, useTicketMutations } from "@/tickets/queries";
import type { TicketRef } from "@/tickets/query-keys";
import { DetailSection, SectionEmpty, SectionHeader } from "./section";
import { TicketPicker } from "./ticket-picker";
import { TicketRefRow } from "./ticket-ref-row";
import { useTicketAction } from "./use-ticket-action";

type LinkDirection = "blockedBy" | "blocks";

interface LinksSectionProps {
  ticket: TicketDetail;
  direction: LinkDirection;
  columnById: ReadonlyMap<string, TicketColumn>;
  onOpenTicket: (ref: TicketRef) => void;
}

/**
 * "Blocked by" lists the tickets this one waits on; "Blocks" lists the tickets
 * that wait on it. Both are one stored link read from either end, so each
 * direction writes the link with the two tickets in the matching order.
 * Links may cross boards; the board host refuses a cycle.
 */
export function LinksSection({
  ticket,
  direction,
  columnById,
  onOpenTicket,
}: LinksSectionProps): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const { tickets: allTickets } = useTicketList(null);
  const { pending, run: setLink } = useTicketAction(
    mutations.setLink,
    t("tickets.detail.errors.saveLink"),
  );
  const linked = direction === "blockedBy" ? ticket.blockedBy : ticket.blocks;
  const candidates = useMemo(() => {
    const excluded = new Set([ticket.id, ...linked.map((other) => other.id)]);
    return allTickets.filter(
      (candidate) => !excluded.has(candidate.id) && candidate.archivedAt === null,
    );
  }, [allTickets, linked, ticket.id]);

  const writeLink = useCallback(
    (other: TicketSummary, isLinked: boolean) => {
      const pair =
        direction === "blockedBy"
          ? { ticketId: ticket.id, blockedByTicketId: other.id }
          : { ticketId: other.id, blockedByTicketId: ticket.id };
      void setLink({ ...pair, linked: isLinked });
    },
    [direction, setLink, ticket.id],
  );
  const handleAdd = useCallback((other: TicketSummary) => writeLink(other, true), [writeLink]);
  const handleRemove = useCallback((other: TicketSummary) => writeLink(other, false), [writeLink]);
  const handleOpen = useCallback(
    (target: TicketSummary) => onOpenTicket({ ticketId: target.id, key: target.key }),
    [onOpenTicket],
  );

  const copy = `tickets.detail.links.${direction}`;
  return (
    <DetailSection testID={`ticket-detail-${direction}`}>
      <SectionHeader
        title={t(`${copy}.title`)}
        tally={linked.length > 0 ? String(linked.length) : undefined}
      >
        <TicketPicker
          label={t("tickets.detail.links.add")}
          title={t(`${copy}.pickerTitle`, { key: ticket.key })}
          candidates={candidates}
          onPick={handleAdd}
          pending={pending}
          testID={`ticket-detail-${direction}-add`}
        />
      </SectionHeader>
      {linked.length === 0 ? (
        <SectionEmpty>{t(`${copy}.empty`)}</SectionEmpty>
      ) : (
        linked.map((other) => (
          <TicketRefRow
            key={other.id}
            ticket={other}
            column={columnById.get(other.columnId) ?? null}
            onOpen={handleOpen}
            onRemove={handleRemove}
            removeLabel={t("tickets.detail.links.remove", { key: other.key })}
          />
        ))
      )}
    </DetailSection>
  );
}
