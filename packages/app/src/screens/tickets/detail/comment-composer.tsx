import { useCallback, useRef, useState, type ReactElement } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TicketActor } from "@getpaseo/protocol/tickets/types";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { Shortcut } from "@/components/ui/shortcut";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useTicketMutations } from "@/tickets/queries";
import { ActorAvatar, actorName } from "./actor-avatar";
import { isSubmitShortcut, SUBMIT_SHORTCUT_KEYS } from "./submit-shortcut";
import { useTicketAction } from "./use-ticket-action";

const USER_ACTOR: TicketActor = { kind: "user" };
const COMMANDER_HANDLE = "commander";
// An "@" at a word start with the partial handle typed after it, at the end of the draft.
const MENTION_AT_END = /(^|\s)@([a-z]*)$/i;

/** True while the draft ends in a partial handle that can still become "@commander". */
function canCompleteCommanderMention(draft: string): boolean {
  const typed = MENTION_AT_END.exec(draft)?.[2]?.toLowerCase();
  return typed !== undefined && typed !== COMMANDER_HANDLE && COMMANDER_HANDLE.startsWith(typed);
}

/**
 * A markdown comment box. ⌘/Ctrl+Enter sends. Typing "@" offers @commander:
 * a user comment that mentions it wakes the Commander on the board host.
 */
export function CommentComposer({ ticketId }: { ticketId: string }): ReactElement {
  const { t } = useTranslation();
  const mutations = useTicketMutations();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const [draft, setDraft] = useState("");
  const { pending, run: addComment } = useTicketAction(
    mutations.addComment,
    t("tickets.detail.errors.addComment"),
  );
  const offersMention = canCompleteCommanderMention(draft);
  const canSend = draft.trim() !== "" && !pending;

  const send = useCallback(async () => {
    const body = draft.trim();
    if (body === "" || pending) {
      return;
    }
    const sent = await addComment({ ticketId, body });
    if (sent) {
      inputRef.current?.reset();
      setDraft("");
    }
  }, [addComment, draft, pending, ticketId]);

  const completeMention = useCallback(() => {
    const next = draft.replace(MENTION_AT_END, `$1@${COMMANDER_HANDLE} `);
    inputRef.current?.replaceText(next, { start: next.length, end: next.length });
    inputRef.current?.focus();
    setDraft(next);
  }, [draft]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (isSubmitShortcut(event)) {
        event.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <View style={styles.composer} testID="ticket-detail-composer">
      <ActorAvatar actor={USER_ACTOR} name={actorName(USER_ACTOR, t)} />
      <View style={styles.body}>
        <FormTextInput
          ref={inputRef}
          onChangeText={setDraft}
          onKeyPress={handleKeyPress}
          multiline
          placeholder={t("tickets.detail.composer.placeholder")}
          accessibilityLabel={t("tickets.detail.composer.label")}
          style={styles.input}
          testID="ticket-detail-composer-input"
        />
        <View style={styles.footer}>
          {offersMention ? (
            <Button
              variant="outline"
              size="xs"
              onPress={completeMention}
              testID="ticket-detail-composer-mention"
            >
              {`@${COMMANDER_HANDLE}`}
            </Button>
          ) : (
            <Text style={styles.hint} numberOfLines={1}>
              {t("tickets.detail.composer.commanderHint")}
            </Text>
          )}
          <View style={styles.sendGroup}>
            <Shortcut keys={SUBMIT_SHORTCUT_KEYS} />
            <Button
              variant="secondary"
              size="sm"
              onPress={send}
              disabled={!canSend}
              loading={pending}
              testID="ticket-detail-composer-send"
            >
              {pending ? t("tickets.detail.composer.sending") : t("tickets.detail.composer.send")}
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  composer: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  input: {
    minHeight: theme.spacing[20],
    textAlignVertical: "top",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  hint: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  sendGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
}));
