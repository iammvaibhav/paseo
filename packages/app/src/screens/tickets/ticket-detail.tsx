import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Archive, Copy, X } from "lucide-react-native";
import type { TicketBoard, TicketColumn, TicketDetail } from "@getpaseo/protocol/tickets/types";
import { BackHeader } from "@/components/headers/back-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { TicketKey } from "@/screens/tickets/components/ticket-key";
import { useTicketBoards, useTicketDetail } from "@/tickets/queries";
import type { TicketRef } from "@/tickets/query-keys";
import { ICON_SIZE, SPACING } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { formatTimeAgo } from "@/utils/time";
import { TicketActions } from "./detail/actions";
import { ActivitySection } from "./detail/activity-section";
import { AttachmentsSection } from "./detail/attachments-section";
import { CommentComposer } from "./detail/comment-composer";
import { DescriptionSection } from "./detail/description-section";
import { LinksSection } from "./detail/links-section";
import { CompactTicketSheetFrame, DesktopTicketPanelFrame } from "./detail/panel-frame";
import { TicketProperties } from "./detail/properties";
import { RunsSection } from "./detail/runs-section";
import { DetailSection } from "./detail/section";
import { SubtasksSection } from "./detail/subtasks-section";
import { TicketTitleField } from "./detail/title-field";
import { NewTicketDialog } from "./new-ticket-dialog";

const ThemedX = withUnistyles(X);
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const CLOSE_ICON = <ThemedX size={ICON_SIZE.md} uniProps={mutedIconColorMapping} />;
const COPY_ICON = <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const ARCHIVED_ICON = <ThemedArchive size={ICON_SIZE.xs} uniProps={mutedIconColorMapping} />;

export interface TicketDetailPanelProps {
  ticketRef: TicketRef;
  onClose: () => void;
  onOpenTicket: (ref: TicketRef) => void;
}

/**
 * One ticket: title, description, properties, hierarchy, blockers,
 * attachments, linked runs and the activity feed. A right side panel over the
 * board on desktop, a full-screen sheet with a back button on compact. It
 * positions itself: mount it as the last child of the screen's root view.
 */
export function TicketDetailPanel(props: TicketDetailPanelProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  if (isCompact) {
    return (
      <CompactTicketSheetFrame>
        <TicketDetailView {...props} isCompact />
      </CompactTicketSheetFrame>
    );
  }
  return (
    <DesktopTicketPanelFrame>
      <TicketDetailView {...props} isCompact={false} />
    </DesktopTicketPanelFrame>
  );
}

function TicketDetailView({
  ticketRef,
  onClose,
  onOpenTicket,
  isCompact,
}: TicketDetailPanelProps & { isCompact: boolean }): ReactElement {
  const { t } = useTranslation();
  const { ticket, isLoading, error } = useTicketDetail(ticketRef);
  const { boards } = useTicketBoards();
  const [isCreatingSubtask, setIsCreatingSubtask] = useState(false);
  const board = ticket
    ? (boards.find((candidate) => candidate.id === ticket.boardId) ?? null)
    : null;
  const columnById = useMemo(() => {
    const columns = new Map<string, TicketColumn>();
    for (const candidate of boards) {
      for (const column of candidate.columns) {
        columns.set(column.id, column);
      }
    }
    return columns;
  }, [boards]);
  const openSubtaskDialog = useCallback(() => setIsCreatingSubtask(true), []);
  const closeSubtaskDialog = useCallback(() => setIsCreatingSubtask(false), []);
  const headerKey = ticket?.key ?? ticketRef.key ?? "";

  const headerActions = useMemo(
    () => (ticket ? <TicketActions ticket={ticket} onDeleted={onClose} /> : null),
    [onClose, ticket],
  );

  let body: ReactElement;
  if (ticket) {
    // Keyed by ticket, so drafts and open editors never carry over to the next ticket.
    body = (
      <TicketBody
        key={ticket.id}
        ticket={ticket}
        board={board}
        columnById={columnById}
        isCompact={isCompact}
        onOpenTicket={onOpenTicket}
        onCreateSubtask={openSubtaskDialog}
      />
    );
  } else if (isLoading) {
    body = (
      <View style={styles.centered}>
        <ThemedLoadingSpinner size="large" uniProps={mutedIconColorMapping} />
      </View>
    );
  } else if (error) {
    body = (
      <View style={styles.message}>
        <Alert
          variant="error"
          title={t("tickets.detail.states.loadFailed")}
          description={error.message}
        />
      </View>
    );
  } else {
    body = (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{t("tickets.detail.states.notFound")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {isCompact ? (
        <BackHeader title={headerKey} rightContent={headerActions} onBack={onClose} />
      ) : (
        <DesktopHeader ticketKey={headerKey} onClose={onClose}>
          {headerActions}
        </DesktopHeader>
      )}
      {body}
      {ticket ? (
        <NewTicketDialog
          visible={isCreatingSubtask}
          boardId={ticket.boardId}
          parentId={ticket.id}
          onClose={closeSubtaskDialog}
          onCreated={closeSubtaskDialog}
        />
      ) : null}
    </View>
  );
}

function DesktopHeader({
  ticketKey,
  onClose,
  children,
}: {
  ticketKey: string;
  onClose: () => void;
  children: ReactElement | null;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      <View style={styles.headerKey}>
        {ticketKey ? <TicketKey ticketKey={ticketKey} /> : null}
        {ticketKey ? <CopyKeyButton ticketKey={ticketKey} /> : null}
      </View>
      {children}
      <Button
        variant="ghost"
        size="xs"
        leftIcon={CLOSE_ICON}
        onPress={onClose}
        accessibilityLabel={t("tickets.detail.close")}
        testID="ticket-detail-close"
      />
    </View>
  );
}

function CopyKeyButton({ ticketKey }: { ticketKey: string }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const handleCopy = useCallback(() => {
    copyToClipboard(ticketKey)
      .then(() => toast.copied(ticketKey))
      .catch(() => toast.error(t("common.errors.unableToCopy")));
  }, [t, ticketKey, toast]);
  return (
    <Button
      variant="ghost"
      size="xs"
      leftIcon={COPY_ICON}
      onPress={handleCopy}
      accessibilityLabel={t("tickets.detail.copyKey", { key: ticketKey })}
      testID="ticket-detail-copy-key"
    />
  );
}

interface TicketBodyProps {
  ticket: TicketDetail;
  board: TicketBoard | null;
  columnById: ReadonlyMap<string, TicketColumn>;
  isCompact: boolean;
  onOpenTicket: (ref: TicketRef) => void;
  onCreateSubtask: () => void;
}

function TicketBody({
  ticket,
  board,
  columnById,
  isCompact,
  onOpenTicket,
  onCreateSubtask,
}: TicketBodyProps): ReactElement {
  // Compact docks the composer under the scroll, so the keyboard lifts it into view.
  const composer = <CommentComposer ticketId={ticket.id} />;
  return (
    <>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={isCompact ? layout.contentCompact : layout.content}
        keyboardShouldPersistTaps="handled"
        testID="ticket-detail-scroll"
      >
        <TicketHeading ticket={ticket} />
        <DetailSection>
          <TicketProperties ticket={ticket} board={board} />
        </DetailSection>
        <SubtasksSection
          ticket={ticket}
          columnById={columnById}
          onOpenTicket={onOpenTicket}
          onCreateSubtask={onCreateSubtask}
        />
        <LinksSection
          ticket={ticket}
          direction="blockedBy"
          columnById={columnById}
          onOpenTicket={onOpenTicket}
        />
        <LinksSection
          ticket={ticket}
          direction="blocks"
          columnById={columnById}
          onOpenTicket={onOpenTicket}
        />
        <AttachmentsSection ticket={ticket} />
        <RunsSection runs={ticket.runs} />
        <ActivitySection ticketKey={ticket.key} activity={ticket.activity} />
        {isCompact ? null : composer}
      </ScrollView>
      {isCompact ? <View style={styles.dockedComposer}>{composer}</View> : null}
    </>
  );
}

function TicketHeading({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const meta = t("tickets.common.createdUpdated", {
    created: formatTimeAgo(new Date(ticket.createdAt)),
    updated: formatTimeAgo(new Date(ticket.updatedAt)),
  });
  const importedFrom = ticket.externalRef
    ? t("tickets.detail.importedFrom", {
        identifier: ticket.externalRef.identifier ?? String(ticket.externalRef.id),
      })
    : null;
  return (
    <View style={styles.heading}>
      {ticket.archivedAt ? (
        <View style={styles.archivedNote} testID="ticket-detail-archived">
          {ARCHIVED_ICON}
          <Text style={styles.archivedText}>{t("tickets.detail.archivedNote")}</Text>
        </View>
      ) : null}
      <TicketTitleField ticket={ticket} />
      <Text style={styles.meta}>{importedFrom ? `${meta} · ${importedFrom}` : meta}</Text>
      <View style={styles.description}>
        <DescriptionSection ticket={ticket} />
      </View>
    </View>
  );
}

// Theme-free: contentContainerStyle is not tracked by Unistyles (docs/unistyles.md).
const layout = {
  content: { paddingHorizontal: SPACING[6], paddingTop: SPACING[4], paddingBottom: SPACING[8] },
  contentCompact: {
    paddingHorizontal: SPACING[4],
    paddingTop: SPACING[3],
    paddingBottom: SPACING[6],
  },
} as const;

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minWidth: 0,
  },
  header: {
    minHeight: theme.spacing[12],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[6],
    paddingRight: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerKey: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  scroll: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  message: {
    padding: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  heading: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[6],
  },
  archivedNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
  },
  archivedText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  description: {
    paddingTop: theme.spacing[4],
  },
  dockedComposer: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
}));
