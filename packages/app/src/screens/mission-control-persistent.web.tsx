import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { usePathname } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TitlebarDragRegionEnabled } from "@/components/desktop/titlebar-drag-region";
import { useLatchedBoolean } from "@/hooks/use-latched-boolean";
import { MissionControlActiveContext } from "@/screens/mission-control/focus-context";
import { MissionControlScreen } from "@/screens/mission-control-screen";

const MISSION_CONTROL_PATH = "/mission-control";

/**
 * Web keep-mounted host for Mission Control. Web navigation unmounts route
 * screens, which destroyed the thread's scroll state on every visit; chats
 * survive because agent tabs are panels that stay mounted. This layer gives
 * Mission Control the same mechanism: mounted on first visit, then hidden
 * while other routes show. The /mission-control route renders nothing on web.
 *
 * Hidden state uses opacity + pointerEvents, NOT display:none — browsers
 * discard descendant scroll positions inside display:none subtrees, which
 * would reintroduce the exact restore-jitter this layer exists to remove.
 */
export function MissionControlPersistent(): ReactElement | null {
  const pathname = usePathname();
  const active = pathname === MISSION_CONTROL_PATH;
  const hasEverBeenActive = useLatchedBoolean(active);
  if (!hasEverBeenActive) {
    return null;
  }
  return (
    <View
      style={[styles.layer, !active && styles.inactive]}
      pointerEvents={active ? "auto" : "none"}
      aria-hidden={!active}
      testID="mission-control-persistent-layer"
    >
      <MissionControlActiveContext.Provider value={active}>
        {/* The hidden layer must not declare drag regions: Blink collects
            -webkit-app-region from the whole layout tree regardless of
            opacity/pointer-events, so the MC header's drag band would sit on
            top of — and eat clicks from — every other screen's header. */}
        <TitlebarDragRegionEnabled enabled={active}>
          <HostRouteBootstrapBoundary>
            <MissionControlScreen />
          </HostRouteBootstrapBoundary>
        </TitlebarDragRegionEnabled>
      </MissionControlActiveContext.Provider>
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
