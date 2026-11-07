import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useBrowserStore } from "@/desktop/browser/store";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  isWorkspaceActive?: boolean;
  onFocusPane?: () => void;
}

const iframeStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  flex: 1,
  border: "none",
  minHeight: 0,
};
export function BrowserPane({ browserId }: BrowserPaneProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  if (browser?.url) {
    return (
      <View style={styles.iframeContainer} testID={`browser-pane-container-${browserId}`}>
        <iframe
          src={browser.url}
          title={browser.title || "VS Code Web"}
          style={iframeStyle}
          // eslint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
          data-testid={`browser-pane-iframe-${browserId}`}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={titleStyle}>{t("workspace.browser.unavailable.title")}</Text>
      <Text style={subtitleStyle}>{t("workspace.browser.unavailable.subtitle")}</Text>
      <Text style={subtitleStyle}>{t("workspace.browser.session", { browserId })}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  iframeContainer: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    height: "100%",
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
  },
}));
