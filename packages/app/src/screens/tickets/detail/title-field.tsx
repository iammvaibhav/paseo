import { useCallback, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TicketDetail } from "@getpaseo/protocol/tickets/types";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useTicketMutations } from "@/tickets/queries";
import { useTicketAction } from "./use-ticket-action";

/**
 * The title, edited in place. It wraps so a long title shows in full, but it
 * stays one line: Enter commits, and line breaks collapse to spaces.
 */
export function TicketTitleField({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const { run: saveTitle } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveTitle"),
  );

  const commit = useCallback(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const next = input.getText().replace(/\s+/g, " ").trim();
    if (next === "") {
      input.replaceText(ticket.title);
      return;
    }
    if (next === ticket.title) {
      return;
    }
    void saveTitle({ ticketId: ticket.id, title: next });
  }, [saveTitle, ticket.id, ticket.title]);

  return (
    <AdaptiveTextInput
      ref={inputRef}
      initialValue={ticket.title}
      resetKey={ticket.title}
      onBlur={commit}
      submitBehavior="blurAndSubmit"
      multiline
      placeholder={t("tickets.detail.titlePlaceholder")}
      accessibilityLabel={t("tickets.detail.titleLabel")}
      style={styles.title}
      testID="ticket-detail-title"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: 0,
    borderRadius: theme.borderRadius.base,
  },
}));
