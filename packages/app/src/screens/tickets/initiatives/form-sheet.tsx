import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type {
  Initiative,
  InitiativeStatus,
  TicketBoard,
  TicketPriority,
} from "@getpaseo/protocol/tickets/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { SaveInitiativeInput } from "@/tickets/queries";
import { toErrorMessage } from "@/utils/error-messages";
import { usePriorityLabel } from "../components/priority-icon";
import { openInitiativeForm, type InitiativeDateError, type InitiativeFormSnapshot } from "./form";
import { INITIATIVE_STATUSES, TICKET_PRIORITIES } from "./status";
import { useInitiativeActions } from "./use-initiative-actions";

type PriorityChoice = TicketPriority | "none";

export interface InitiativeFormSheetProps {
  serverId: string;
  visible: boolean;
  /** Read once per mount. Give the sheet a new `key` for each open. */
  snapshot: InitiativeFormSnapshot;
  /** Board choices of a create form; the field shows when there is more than one. */
  boards: readonly TicketBoard[];
  onClose: () => void;
  onSaved: (initiative: Initiative) => void;
}

const DATE_ERROR_KEY: Record<InitiativeDateError, string> = {
  invalid: "tickets.initiatives.form.invalidDate",
  beforeStart: "tickets.initiatives.form.targetBeforeStart",
};

export function InitiativeFormSheet({
  serverId,
  visible,
  snapshot,
  boards,
  onClose,
  onSaved,
}: InitiativeFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const priorityLabel = usePriorityLabel();
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [form] = useState(() => openInitiativeForm(snapshot));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const actions = useInitiativeActions(serverId);

  const mutation = useMutation({
    mutationFn: (submission: SaveInitiativeInput) => actions.save(submission),
    onSuccess: onSaved,
    onError: (error) =>
      form.setSubmitError(
        t("tickets.initiatives.form.saveFailed", { message: toErrorMessage(error) }),
      ),
  });
  const isSaving = mutation.isPending;

  const handleClose = useCallback(() => {
    if (!isSaving) {
      onClose();
    }
  }, [isSaving, onClose]);

  const handleSubmit = useCallback(() => {
    if (state.submission && state.canSubmit) {
      mutation.mutate(state.submission);
    }
  }, [mutation, state.canSubmit, state.submission]);

  const boardOptions = useMemo<SelectFieldOption<string>[]>(
    () => boards.map((board) => ({ id: board.id, value: board.id, label: board.name })),
    [boards],
  );
  const statusOptions = useMemo<SelectFieldOption<InitiativeStatus>[]>(
    () =>
      INITIATIVE_STATUSES.map((status) => ({
        id: status,
        value: status,
        label: t(`tickets.initiatives.status.${status}`),
      })),
    [t],
  );
  const priorityOptions = useMemo<SelectFieldOption<PriorityChoice>[]>(
    () => [
      ...TICKET_PRIORITIES.map((priority) => ({
        id: priority,
        value: priority,
        label: priorityLabel(priority),
      })),
      { id: "none", value: "none", label: t("tickets.initiatives.noPriority") },
    ],
    [priorityLabel, t],
  );

  const handleBoardChange = useCallback(
    (boardId: string, display: { label: string }) =>
      form.setBoard({ id: boardId, name: display.label }),
    [form],
  );
  const handlePriorityChange = useCallback(
    (choice: PriorityChoice) => form.setPriority(choice === "none" ? null : choice),
    [form],
  );

  const statusDisplay = useMemo(
    () => ({ label: t(`tickets.initiatives.status.${state.status}`) }),
    [state.status, t],
  );
  const priorityDisplay = useMemo(
    () => ({
      label: state.priority ? priorityLabel(state.priority) : t("tickets.initiatives.noPriority"),
    }),
    [priorityLabel, state.priority, t],
  );
  const boardDisplay = useMemo(
    () => (state.board ? { label: state.board.name } : null),
    [state.board],
  );

  const isCreate = state.mode === "create";
  const header = useMemo<SheetHeader>(
    () => ({
      title: isCreate
        ? t("tickets.initiatives.form.createTitle")
        : t("tickets.initiatives.form.editTitle"),
    }),
    [isCreate, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" size="md" onPress={handleClose} disabled={isSaving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="md"
          onPress={handleSubmit}
          disabled={!state.canSubmit}
          loading={isSaving}
          testID="initiative-form-submit"
        >
          {isCreate ? t("tickets.initiatives.form.create") : t("tickets.initiatives.form.save")}
        </Button>
      </View>
    ),
    [handleClose, handleSubmit, isCreate, isSaving, state.canSubmit, t],
  );

  const showBoardField = isCreate && boards.length > 1;
  const startDateError = state.startDateError ? t(DATE_ERROR_KEY[state.startDateError]) : null;
  const targetDateError = state.targetDateError ? t(DATE_ERROR_KEY[state.targetDateError]) : null;

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      testID="initiative-form-sheet"
    >
      <Field label={t("tickets.initiatives.form.title")}>
        <FormTextInput
          size={size}
          testID="initiative-form-title"
          accessibilityLabel={t("tickets.initiatives.form.title")}
          initialValue={state.title}
          onChangeText={form.setTitle}
          onSubmitEditing={handleSubmit}
          placeholder={t("tickets.initiatives.form.titlePlaceholder")}
          editable={!isSaving}
          autoFocus={isCreate}
        />
      </Field>

      <Field label={t("tickets.initiatives.form.description")}>
        <SettingsTextArea
          accessibilityLabel={t("tickets.initiatives.form.description")}
          value={state.description}
          onChangeText={form.setDescription}
          placeholder={t("tickets.initiatives.form.descriptionPlaceholder")}
          editable={!isSaving}
          testID="initiative-form-description"
        />
      </Field>

      {showBoardField ? (
        <SelectField
          label={t("tickets.initiatives.form.board")}
          value={state.board ? state.board.id : null}
          selectedDisplay={boardDisplay}
          options={boardOptions}
          onChange={handleBoardChange}
          placeholder={t("tickets.initiatives.form.boardPlaceholder")}
          emptyText={t("tickets.initiatives.form.noBoards")}
          disabled={isSaving}
          size={size}
          testID="initiative-form-board"
        />
      ) : null}

      <View style={styles.pair}>
        <View style={styles.pairItem}>
          <SelectField
            label={t("tickets.initiatives.form.status")}
            value={state.status}
            selectedDisplay={statusDisplay}
            options={statusOptions}
            onChange={form.setStatus}
            placeholder={t("tickets.initiatives.form.status")}
            emptyText={t("tickets.initiatives.form.status")}
            disabled={isSaving}
            size={size}
            testID="initiative-form-status"
          />
        </View>
        <View style={styles.pairItem}>
          <SelectField
            label={t("tickets.initiatives.form.priority")}
            value={state.priority ?? "none"}
            selectedDisplay={priorityDisplay}
            options={priorityOptions}
            onChange={handlePriorityChange}
            placeholder={t("tickets.initiatives.noPriority")}
            emptyText={t("tickets.initiatives.noPriority")}
            disabled={isSaving}
            size={size}
            testID="initiative-form-priority"
          />
        </View>
      </View>

      <View style={styles.pair}>
        <View style={styles.pairItem}>
          <Field label={t("tickets.initiatives.form.startDate")} error={startDateError}>
            <FormTextInput
              size={size}
              testID="initiative-form-start-date"
              accessibilityLabel={t("tickets.initiatives.form.startDate")}
              initialValue={state.startDate}
              onChangeText={form.setStartDate}
              onBlur={form.leaveStartDate}
              placeholder={t("tickets.initiatives.form.datePlaceholder")}
              editable={!isSaving}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
          </Field>
        </View>
        <View style={styles.pairItem}>
          <Field label={t("tickets.initiatives.form.targetDate")} error={targetDateError}>
            <FormTextInput
              size={size}
              testID="initiative-form-target-date"
              accessibilityLabel={t("tickets.initiatives.form.targetDate")}
              initialValue={state.targetDate}
              onChangeText={form.setTargetDate}
              onBlur={form.leaveTargetDate}
              placeholder={t("tickets.initiatives.form.datePlaceholder")}
              editable={!isSaving}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
          </Field>
        </View>
      </View>

      {state.submitError ? (
        <Text style={styles.submitError} testID="initiative-form-error">
          {state.submitError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  pair: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  pairItem: {
    flex: 1,
    minWidth: 0,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
