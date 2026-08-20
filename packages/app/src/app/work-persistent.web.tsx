import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { usePathname } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TitlebarDragRegionEnabled } from "@/components/desktop/titlebar-drag-region";
import { useLatchedBoolean } from "@/hooks/use-latched-boolean";
import { WorkScreen } from "@/screens/work-screen";

const WORK_PATH = "/work";

/**
 * Web keep-mounted host for Work. Web navigation unmounts route
 * screens, which destroyed the board's scroll state on every visit; chats
 * survive because agent tabs are panels that stay mounted. This layer gives
 * Work the same mechanism: mounted on first visit, then hidden
 * while other routes show. The /work route renders nothing on web.
 *
 * Hidden state uses opacity + pointerEvents, NOT display:none — browsers
 * discard descendant scroll positions inside display:none subtrees, which
 * would reintroduce the exact restore-jitter this layer exists to remove.
 */
export function WorkPersistent(): ReactElement | null {
  const pathname = usePathname();
  const active = pathname === WORK_PATH;
  const hasEverBeenActive = useLatchedBoolean(active);
  if (!hasEverBeenActive) {
    return null;
  }
  return (
    <View
      style={[styles.layer, !active && styles.inactive]}
      pointerEvents={active ? "auto" : "none"}
      aria-hidden={!active}
      testID="work-persistent-layer"
    >
      <TitlebarDragRegionEnabled enabled={active}>
        <HostRouteBootstrapBoundary>
          <WorkScreen />
        </HostRouteBootstrapBoundary>
      </TitlebarDragRegionEnabled>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
    backgroundColor: theme.colors.background,
  },
  inactive: {
    opacity: 0,
    zIndex: -1,
  },
}));
