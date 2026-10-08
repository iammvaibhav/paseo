import { useCallback, useMemo, useReducer, type ReactElement } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TicketDetail } from "@getpaseo/protocol/tickets/types";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Shortcut } from "@/components/ui/shortcut";
import { useTicketMutations } from "@/tickets/queries";
import { isSubmitShortcut, SUBMIT_SHORTCUT_KEYS } from "./submit-shortcut";
import { useTicketAction } from "./use-ticket-action";

type EditorTab = "write" | "preview";

type DescriptionState = { mode: "view" } | { mode: "edit"; tab: EditorTab; draft: string };

type DescriptionAction =
  | { type: "edit"; description: string }
  | { type: "tab"; tab: EditorTab }
  | { type: "draft"; draft: string }
  | { type: "close" };

function reduceDescription(state: DescriptionState, action: DescriptionAction): DescriptionState {
  switch (action.type) {
    case "edit":
      return { mode: "edit", tab: "write", draft: action.description };
    case "tab":
      return state.mode === "edit" ? { ...state, tab: action.tab } : state;
    case "draft":
      return state.mode === "edit" ? { ...state, draft: action.draft } : state;
    case "close":
      return { mode: "view" };
  }
}

const VIEW_STATE: DescriptionState = { mode: "view" };

/** Markdown description: rendered, or edited in a plain input with a preview tab. */
export function DescriptionSection({ ticket }: { ticket: TicketDetail }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const [state, dispatch] = useReducer(reduceDescription, VIEW_STATE);
  const { pending, run: saveDescription } = useTicketAction(
    mutations.updateTicket,
    t("tickets.detail.errors.saveDescription"),
  );

  const startEditing = useCallback(
    () => dispatch({ type: "edit", description: ticket.description }),
    [ticket.description],
  );

  if (state.mode === "view") {
    return <DescriptionView description={ticket.description} onEdit={startEditing} />;
  }
  return (
    <DescriptionEditor
      ticketId={ticket.id}
      tab={state.tab}
      draft={state.draft}
      pending={pending}
      dispatch={dispatch}
      save={saveDescription}
    />
  );
}

function DescriptionView({
  description,
  onEdit,
}: {
  description: string;
  onEdit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const hasDescription = description.trim() !== "";

  if (!hasDescription) {
    return (
      <Pressable
        onPress={onEdit}
        style={placeholderStyle}
        accessibilityRole="button"
        testID="ticket-detail-description-add"
      >
        <Text style={styles.placeholderText}>{t("tickets.detail.description.placeholder")}</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.view} testID="ticket-detail-description">
      <MarkdownRenderer text={description} />
      <View style={styles.viewActions}>
        <Button variant="ghost" size="xs" onPress={onEdit} testID="ticket-detail-description-edit">
          {t("tickets.detail.description.edit")}
        </Button>
      </View>
    </View>
  );
}

function placeholderStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.placeholder, hovered && styles.placeholderHovered];
}

interface DescriptionEditorProps {
  ticketId: string;
  tab: EditorTab;
  draft: string;
  pending: boolean;
  dispatch: (action: DescriptionAction) => void;
  save: (input: { ticketId: string; description: string }) => Promise<boolean>;
}

function DescriptionEditor({
  ticketId,
  tab,
  draft,
  pending,
  dispatch,
  save,
}: DescriptionEditorProps): ReactElement {
  const { t } = useTranslation();
  const tabs = useMemo<SegmentedControlOption<EditorTab>[]>(
    () => [
      { value: "write", label: t("tickets.detail.description.write") },
      { value: "preview", label: t("tickets.detail.description.preview") },
    ],
    [t],
  );
  const handleTab = useCallback(
    (next: EditorTab) => dispatch({ type: "tab", tab: next }),
    [dispatch],
  );
  const handleDraft = useCallback(
    (text: string) => dispatch({ type: "draft", draft: text }),
    [dispatch],
  );
  const handleCancel = useCallback(() => dispatch({ type: "close" }), [dispatch]);
  const handleSave = useCallback(async () => {
    const saved = await save({ ticketId, description: draft });
    if (saved) {
      dispatch({ type: "close" });
    }
  }, [dispatch, draft, save, ticketId]);
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (isSubmitShortcut(event)) {
        event.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  return (
    <View style={styles.editor} testID="ticket-detail-description-editor">
      <SegmentedControl options={tabs} value={tab} onValueChange={handleTab} size="xs" />
      {tab === "write" ? (
        <FormTextInput
          initialValue={draft}
          onChangeText={handleDraft}
          onKeyPress={handleKeyPress}
          multiline
          autoFocus
          placeholder={t("tickets.detail.description.inputPlaceholder")}
          accessibilityLabel={t("tickets.detail.description.label")}
          style={styles.input}
          testID="ticket-detail-description-input"
        />
      ) : (
        <View style={styles.preview}>
          {draft.trim() === "" ? (
            <Text style={styles.placeholderText}>
              {t("tickets.detail.description.emptyPreview")}
            </Text>
          ) : (
            <MarkdownRenderer text={draft} />
          )}
        </View>
      )}
      <View style={styles.editorFooter}>
        <Shortcut keys={SUBMIT_SHORTCUT_KEYS} />
        <View style={styles.editorButtons}>
          <Button variant="ghost" size="sm" onPress={handleCancel} disabled={pending}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleSave}
            loading={pending}
            testID="ticket-detail-description-save"
          >
            {pending ? t("tickets.detail.saving") : t("tickets.detail.description.save")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  view: {
    gap: theme.spacing[1],
  },
  viewActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  placeholder: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  placeholderHovered: {
    backgroundColor: theme.colors.surface1,
  },
  placeholderText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  editor: {
    gap: theme.spacing[2],
  },
  input: {
    minHeight: theme.spacing[32],
    textAlignVertical: "top",
  },
  preview: {
    minHeight: theme.spacing[32],
    paddingVertical: theme.spacing[2],
  },
  editorFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  editorButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
}));
