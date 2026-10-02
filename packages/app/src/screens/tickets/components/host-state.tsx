import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { CloudOff, SquareKanban } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { ICON_SIZE } from "@/styles/theme";
import type { TicketsHost } from "@/tickets/use-tickets-host";

const ThemedSquareKanban = withUnistyles(SquareKanban);
const ThemedCloudOff = withUnistyles(CloudOff);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const CONNECTING_ICON = <ThemedLoadingSpinner uniProps={mutedIconColorMapping} />;
const NO_BOARD_HOST_ICON = (
  <ThemedSquareKanban size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />
);
const OFFLINE_ICON = <ThemedCloudOff size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;

/** Centered, muted state block: icon, one title line, one description, optional actions. */
export function TicketsStateMessage({
  icon,
  title,
  description,
  children,
  testID,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.centered} testID={testID}>
      <View style={styles.stack}>
        {icon}
        <View style={styles.textStack}>
          <Text style={styles.title}>{title}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
        </View>
        {children ? <View style={styles.actions}>{children}</View> : null}
      </View>
    </View>
  );
}

/** Renders why the board is not available. Only call it while `host.status !== "ready"`. */
export function TicketsHostState({ host }: { host: TicketsHost }): ReactElement {
  const { t } = useTranslation();
  if (host.isConnecting && host.status === "offline") {
    return (
      <TicketsStateMessage
        testID="tickets-host-connecting"
        icon={CONNECTING_ICON}
        title={t("tickets.board.states.connecting")}
      />
    );
  }
  if (host.status === "no_board_host") {
    return (
      <TicketsStateMessage
        testID="tickets-no-board-host"
        icon={NO_BOARD_HOST_ICON}
        title={t("tickets.board.states.noBoardHost.title")}
        description={t("tickets.board.states.noBoardHost.description")}
      />
    );
  }
  const offlineCopy = host.hostLabel
    ? {
        title: t("tickets.board.states.offline.title", { host: host.hostLabel }),
        description: t("tickets.board.states.offline.description"),
      }
    : {
        title: t("tickets.board.states.offlineUnknown.title"),
        description: t("tickets.board.states.offlineUnknown.description"),
      };
  return (
    <TicketsStateMessage
      testID="tickets-host-offline"
      icon={OFFLINE_ICON}
      title={offlineCopy.title}
      description={offlineCopy.description}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  stack: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  textStack: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
}));
