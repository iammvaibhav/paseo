import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Bot, UserRound } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TicketAssignee } from "@getpaseo/protocol/tickets/types";
import { mutedIconColorMapping } from "@/components/ui/icon-color";

const ASSIGNEE_ICONS = {
  user: withUnistyles(UserRound),
  commander: withUnistyles(Bot),
} as const;

const DEFAULT_SIZE = 20;
// The glyph sits inside the disc with an even ring of fill around it.
const GLYPH_RATIO = 0.6;

/** Nothing renders for an unassigned ticket; the card stays quiet. */
export function AssigneeAvatar({
  assignee,
  size = DEFAULT_SIZE,
}: {
  assignee: TicketAssignee | null;
  size?: number;
}): ReactElement | null {
  const { t } = useTranslation();
  if (assignee === null) {
    return null;
  }
  const Icon = ASSIGNEE_ICONS[assignee];
  return (
    <View
      accessible
      accessibilityLabel={t(`tickets.common.assignee.${assignee}`)}
      style={styles.avatar(size)}
    >
      <Icon size={Math.round(size * GLYPH_RATIO)} uniProps={mutedIconColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  avatar: (size: number) => ({
    width: size,
    height: size,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  }),
}));
