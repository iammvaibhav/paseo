import type { ReactElement } from "react";
import { Text, View } from "react-native";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TicketActor } from "@getpaseo/protocol/tickets/types";
import { AssigneeAvatar } from "@/screens/tickets/components/assignee-avatar";
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";

export const ACTOR_AVATAR_SIZE = 24;

/** Imported actors keep their itsaplan display name. */
export function actorName(actor: TicketActor, t: TFunction): string {
  switch (actor.kind) {
    case "user":
      return t("tickets.common.assignee.user");
    case "commander":
      return t("tickets.common.assignee.commander");
    case "agent":
      return actor.name ?? t("tickets.common.agentFallback");
    case "system":
      return t("tickets.detail.activity.systemActor");
    case "imported":
      return actor.name;
  }
}

function identityKey(actor: TicketActor): string {
  if (actor.kind === "agent") {
    return actor.agentId;
  }
  if (actor.kind === "imported") {
    return actor.name.toLowerCase();
  }
  return actor.kind;
}

/**
 * You and the Commander use the assignee glyphs. Agents, imported authors and
 * the system get an identity-colored initial, as the PR panel does.
 */
export function ActorAvatar({ actor, name }: { actor: TicketActor; name: string }): ReactElement {
  if (actor.kind === "user" || actor.kind === "commander") {
    return <AssigneeAvatar assignee={actor.kind} size={ACTOR_AVATAR_SIZE} />;
  }
  const color = identityColor(deriveIdentityColorName(identityKey(actor)));
  return (
    <View style={styles.initialDisc(color)}>
      <Text style={styles.initial}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  initialDisc: (color: string) => ({
    width: ACTOR_AVATAR_SIZE,
    height: ACTOR_AVATAR_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: color,
    alignItems: "center",
    justifyContent: "center",
  }),
  initial: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.palette.white,
  },
}));
