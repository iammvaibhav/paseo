import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Platform, Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";

/**
 * The ONE reusable anchored-list surface. Both the agent chat
 * (`AgentStreamView`) and the Mission Control thread render through it: the
 * platform strategy (web DOM viewport / native inverted FlatList) transports
 * the rows, and the surface owns the near-bottom state plus the jump-to-bottom
 * affordance, so every caller gets the exact same scroll mechanism and the
 * exact same affordance.
 */
export interface AnchoredListProps<T> extends Omit<
  StreamRenderInput<T>,
  "viewportRef" | "onNearBottomChange"
> {
  /** The platform strategy implementation (web or native). */
  strategy: StreamStrategy;
  /** Handle the caller uses to jump to the tail programmatically. */
  viewportRef: RefObject<StreamViewportHandle | null>;
  /** Mirrors the viewport's near-bottom state (used by callers that render
   * their own affordance extras, e.g. the MC "N new" pill). */
  onNearBottomChange?: (value: boolean) => void;
  /** Force the affordance visible even while near the bottom (agent chat's
   * timeline-detached state). */
  forceShowScrollToBottom?: boolean;
  /** Replaces the default chevron affordance (e.g. the MC "N new" pill).
   * The surface still controls visibility via the near-bottom state. */
  scrollToBottomAffordance?: ReactNode;
  /** Custom press handler; defaults to `viewportRef.scrollToBottom`. */
  onScrollToBottomPress?: () => void;
}

function DefaultScrollToBottomButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  // Keep entry/exit animations off on Android due to RN dispatchDraw crashes
  // tracked in react-native-reanimated#8422.
  const shouldDisableEntryExitAnimations = Platform.OS === "android";
  return (
    <Animated.View
      entering={shouldDisableEntryExitAnimations ? undefined : FadeIn.duration(200)}
      exiting={shouldDisableEntryExitAnimations ? undefined : FadeOut.duration(200)}
    >
      <Pressable
        style={styles.scrollToBottomButton}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.scrollToBottom")}
        testID="scroll-to-bottom-button"
      >
        <ChevronDown size={24} color={styles.scrollToBottomIcon.color} />
      </Pressable>
    </Animated.View>
  );
}

export function AnchoredList<T>({
  strategy,
  viewportRef,
  onNearBottomChange,
  forceShowScrollToBottom = false,
  scrollToBottomAffordance,
  onScrollToBottomPress,
  agentId,
  ...renderInput
}: AnchoredListProps<T>): ReactElement {
  const [isNearBottom, setIsNearBottom] = useState(true);
  const onNearBottomChangeRef = useRef(onNearBottomChange);
  onNearBottomChangeRef.current = onNearBottomChange;
  const handleNearBottomChange = useCallback((value: boolean) => {
    setIsNearBottom(value);
    onNearBottomChangeRef.current?.(value);
  }, []);
  const onScrollToBottomPressRef = useRef(onScrollToBottomPress);
  onScrollToBottomPressRef.current = onScrollToBottomPress;
  const handleScrollToBottomPress = useCallback(() => {
    if (onScrollToBottomPressRef.current) {
      onScrollToBottomPressRef.current();
      return;
    }
    viewportRef.current?.scrollToBottom("jump-to-bottom");
  }, [viewportRef]);
  // A new agent mounts a fresh viewport (the web strategy keys on agentId);
  // reset the affordance state so a previously detached surface never shows a
  // stale affordance over the newly landed tail.
  useEffect(() => {
    setIsNearBottom(true);
  }, [agentId]);

  const showScrollToBottom = !isNearBottom || forceShowScrollToBottom;
  return (
    <View style={styles.container}>
      {strategy.render({
        agentId,
        ...renderInput,
        viewportRef,
        onNearBottomChange: handleNearBottomChange,
      })}
      {showScrollToBottom ? (
        <View style={styles.scrollToBottomContainer} pointerEvents="box-none">
          {scrollToBottomAffordance ?? (
            <DefaultScrollToBottomButton onPress={handleScrollToBottomPress} />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  scrollToBottomContainer: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scrollToBottomButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  scrollToBottomIcon: {
    color: theme.colors.foreground,
  },
}));
