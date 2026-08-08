import {
  Fragment,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Keyboard,
  Platform,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { type BottomAnchorMode, useBottomAnchorController } from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
  resolveDefaultItemKey,
} from "./strategy";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationTransition,
} from "./history-start-pagination";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const historyStartSlotStyle: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  flexShrink: 0,
};
interface SavedNativeScrollPosition {
  offsetY: number;
  mode: BottomAnchorMode;
}

const HISTORY_START_SETTLE_FRAMES = 2;

interface HistoryRowDisplayVariants {
  regular?: unknown;
  compact?: unknown;
}

const historyRowDisplayVariants = new WeakMap<object, HistoryRowDisplayVariants>();

function getHistoryRowDisplayVariant<T>(item: T, compact: boolean): T {
  // The cache is keyed by object identity; WeakMap requires an object key and
  // rows are always objects, so the cast is only for the type system.
  const key = item as unknown as object;
  let variants = historyRowDisplayVariants.get(key);
  if (!variants) {
    variants = {};
    historyRowDisplayVariants.set(key, variants);
  }
  const variantKey = compact ? "compact" : "regular";
  const existing = variants[variantKey];
  if (existing !== undefined) {
    return existing as T;
  }
  const next = { ...item };
  variants[variantKey] = next;
  return next;
}

function NativeStreamViewport<T>(props: StreamRenderInput<T> & { strategy: StreamStrategy }) {
  const {
    agentId,
    segments,
    historyRowRevision,
    liveHeadRowRevision,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    olderHistoryProgressKey,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    strategy,
    keyExtractor,
    topSlot,
  } = props;
  const { renderHistoryMountedRow, renderLiveHeadRow, renderLiveAuxiliary } = renderers;
  const isActive = useRetainedPanelActive();
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const flatListRef = useRef<FlatList<T>>(null);
  const resolveKey = useCallback(
    (item: T, index: number): string =>
      keyExtractor ? keyExtractor(item, index) : resolveDefaultItemKey(item, index),
    [keyExtractor],
  );
  const streamViewportMetricsRef = useRef({
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  });
  const scrollOffsetYRef = useRef(0);
  const isUserScrollActiveRef = useRef(false);
  const scrollKeyboardDismiss = useScrollKeyboardDismiss();
  const userScrollEndFrameIdRef = useRef<number | null>(null);
  const programmaticScrollEventBudgetRef = useRef(0);
  const [isNativeViewportSettling, setIsNativeViewportSettling] = useState(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);
  const wasActiveRef = useRef(isActive);
  const savedScrollPositionRef = useRef<SavedNativeScrollPosition | null>(null);
  const suppressStickyRestickRef = useRef(false);
  const pendingRestoreFrameRef = useRef<number | null>(null);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);

  const historyItems = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);
  // Keep unchanged item identities intact so live updates only rerender rows
  // whose projected content or local display state actually changed. A rare
  // breakpoint change intentionally refreshes the whole history window.
  const globallyRevisedHistoryRows = useMemo(() => {
    const globalDisplayState = historyRowRevision?.globalDisplayState ?? false;
    return historyItems.map((item) => getHistoryRowDisplayVariant(item, globalDisplayState));
  }, [historyItems, historyRowRevision?.globalDisplayState]);
  const displayStateHistoryRows = useMemo(
    () =>
      globallyRevisedHistoryRows.map((item, index) =>
        historyRowRevision?.displayStateById.has(resolveKey(item, index)) ? { ...item } : item,
      ),
    [globallyRevisedHistoryRows, historyRowRevision?.displayStateById, resolveKey],
  );
  const historyRows = useMemo(
    () =>
      displayStateHistoryRows.map((item, index) =>
        historyRowRevision?.contentById.has(resolveKey(item, index)) ? { ...item } : item,
      ),
    [displayStateHistoryRows, historyRowRevision?.contentById, resolveKey],
  );
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput => {
    const metrics = streamViewportMetricsRef.current;
    const hasMeasuredViewport =
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey;
    return {
      distanceFromHistoryStart: metrics.contentHeight - metrics.viewportHeight - metrics.offsetY,
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady: historyStartReadyRef.current && hasMeasuredViewport,
      progressKey: olderHistoryProgressKey,
    };
  });
  const applyHistoryStartPaginationTransition = useStableEvent(
    (transition: HistoryStartPaginationTransition) => {
      const previousState = historyStartPaginationStateRef.current;
      historyStartPaginationStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setHistoryStartPaginationState(transition.state);
      }
      if (transition.shouldLoad) {
        const requestedProgressKey = olderHistoryProgressKey;
        if (requestedProgressKey === null) {
          return;
        }
        void (async () => {
          const started = await onNearHistoryStart();
          if (started === true) {
            return;
          }
          applyHistoryStartPaginationTransition({
            state: abandonHistoryStartPaginationRequest(
              historyStartPaginationStateRef.current,
              requestedProgressKey,
            ),
            shouldLoad: false,
          });
        })();
      }
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      getHistoryStartPaginationInput(),
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const scheduleHistoryStartSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => getHistoryStartPaginationInput().isLoadingOlderHistory,
        onSettle: () => {
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            getHistoryStartPaginationInput(),
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  const clearNativeViewportSettling = useCallback(() => {
    if (nativeViewportSettlingFrameIdRef.current !== null) {
      cancelAnimationFrame(nativeViewportSettlingFrameIdRef.current);
      nativeViewportSettlingFrameIdRef.current = null;
    }
  }, []);

  const clearPendingUserScrollEnd = useCallback(() => {
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  }, []);

  const markNativeViewportSettling = useCallback(() => {
    clearNativeViewportSettling();
    setIsNativeViewportSettling(true);
    let remainingFrames = 4;
    const tick = () => {
      if (remainingFrames <= 0) {
        nativeViewportSettlingFrameIdRef.current = null;
        setIsNativeViewportSettling(false);
        return;
      }
      remainingFrames -= 1;
      nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
    };
    nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
  }, [clearNativeViewportSettling]);

  const bottomAnchorTransportBehavior = useMemo(
    () =>
      resolveBottomAnchorTransportBehavior({
        strategy,
        isViewportSettling: isNativeViewportSettling,
      }),
    [isNativeViewportSettling, strategy],
  );

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({
        offset: 0,
        animated,
      });
      scrollOffsetYRef.current = 0;
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        offsetY: 0,
      };
      onNearBottomChange(true);
    },
    [onNearBottomChange],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId,
    routeRequest: routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    renderStrategy: "inverted-stream",
    transportBehavior: bottomAnchorTransportBehavior,
    getMeasurementState: () => streamViewportMetricsRef.current,
    isNearBottom: () => {
      const metrics = streamViewportMetricsRef.current;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: metrics.offsetY,
        threshold: 32,
        contentHeight: metrics.contentHeight,
        viewportHeight: metrics.viewportHeight,
      });
    },
    scrollToBottom,
  });
  // Android's maintainVisibleContentPosition ignores the list inversion transform and
  // fights the controller's offset-zero correction while the live header grows.
  const maintainVisibleContentPosition =
    Platform.OS === "android" && bottomAnchorController.mode === "sticky-bottom"
      ? undefined
      : DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION;

  const cancelPendingScrollRestore = useCallback(() => {
    const pendingFrame = pendingRestoreFrameRef.current;
    if (pendingFrame !== null) {
      pendingRestoreFrameRef.current = null;
      cancelAnimationFrame(pendingFrame);
    }
  }, []);

  const restoreDetachedScrollPosition = useCallback(
    (offsetY: number) => {
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({
        offset: offsetY,
        animated: false,
      });
      scrollOffsetYRef.current = offsetY;
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        offsetY,
      };
      const nearBottom = isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY,
        threshold: 32,
        contentHeight: streamViewportMetricsRef.current.contentHeight,
        viewportHeight: streamViewportMetricsRef.current.viewportHeight,
      });
      onNearBottomChange(nearBottom);
    },
    [onNearBottomChange, strategy],
  );

  const bottomAnchorModeRef = useRef(bottomAnchorController.mode);
  bottomAnchorModeRef.current = bottomAnchorController.mode;

  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;

    if (wasActive && !isActive) {
      cancelPendingScrollRestore();
      suppressStickyRestickRef.current = true;
      savedScrollPositionRef.current = {
        offsetY: scrollOffsetYRef.current,
        mode: bottomAnchorModeRef.current,
      };
      return;
    }

    if (wasActive || !isActive) {
      return;
    }

    const saved = savedScrollPositionRef.current;
    savedScrollPositionRef.current = null;
    if (!saved || saved.mode === "sticky-bottom") {
      suppressStickyRestickRef.current = false;
      return;
    }

    suppressStickyRestickRef.current = true;
    cancelPendingScrollRestore();
    const restore = () => {
      pendingRestoreFrameRef.current = null;
      restoreDetachedScrollPosition(saved.offsetY);
      pendingRestoreFrameRef.current = requestAnimationFrame(() => {
        pendingRestoreFrameRef.current = null;
        suppressStickyRestickRef.current = false;
      });
    };
    pendingRestoreFrameRef.current = requestAnimationFrame(() => {
      pendingRestoreFrameRef.current = requestAnimationFrame(restore);
    });
  }, [cancelPendingScrollRestore, isActive, restoreDetachedScrollPosition]);

  useEffect(() => {
    return () => {
      cancelPendingScrollRestore();
    };
  }, [cancelPendingScrollRestore]);

  useEffect(() => {
    streamViewportMetricsRef.current = {
      containerKey: "native-virtualized",
      contentHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      offsetY: 0,
      viewportMeasuredForKey: null,
      contentMeasuredForKey: null,
    };
    scrollOffsetYRef.current = 0;
    isUserScrollActiveRef.current = false;
    clearPendingUserScrollEnd();
    clearNativeViewportSettling();
    setIsNativeViewportSettling(false);
    historyStartReadyRef.current = false;
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearPendingUserScrollEnd();
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [agentId, clearNativeViewportSettling, clearPendingUserScrollEnd, evaluateHistoryStart]);

  useEffect(() => {
    const keyboardEvents = [
      "keyboardWillShow",
      "keyboardWillHide",
      "keyboardDidShow",
      "keyboardDidHide",
      "keyboardWillChangeFrame",
      "keyboardDidChangeFrame",
    ] as const;
    const subscriptions = keyboardEvents.map((eventName) =>
      Keyboard.addListener(eventName, () => {
        markNativeViewportSettling();
      }),
    );
    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
      clearNativeViewportSettling();
    };
  }, [clearNativeViewportSettling, markNativeViewportSettling]);

  useEffect(() => {
    if (!isActive || suppressStickyRestickRef.current) {
      return;
    }
    bottomAnchorController.prepareForStickyContentChange();
  }, [bottomAnchorController, historyRows, isActive, segments.liveHead]);

  const scrollToItemId = useStableEvent((itemId: string) => {
    suppressStickyRestickRef.current = true;
    const index = historyRows.findIndex((row) => resolveKey(row, 0) === itemId);
    if (index < 0) {
      return;
    }
    programmaticScrollEventBudgetRef.current = 3;
    flatListRef.current?.scrollToIndex({
      index,
      animated: true,
      viewPosition: 0,
    });
    onNearBottomChange(false);
  });

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: (reason = "jump-to-bottom") => {
        suppressStickyRestickRef.current = false;
        bottomAnchorController.requestLocalAnchor({
          agentId,
          reason,
        });
      },
      scrollToMessage: scrollToItemId,
      prepareForViewportChange: () => {
        if (suppressStickyRestickRef.current) {
          return;
        }
        bottomAnchorController.prepareForStickyViewportChange();
        markNativeViewportSettling();
      },
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [agentId, bottomAnchorController, markNativeViewportSettling, scrollToItemId, viewportRef]);

  const isScrollEventNearBottom = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: contentOffset.y,
        threshold: 32,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
    },
  );

  const handleScroll = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!isActiveRef.current) {
      return;
    }
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffsetY = scrollOffsetYRef.current;
    scrollOffsetYRef.current = contentOffset.y;
    scrollKeyboardDismiss.onScroll(event);

    streamViewportMetricsRef.current = {
      contentHeight: Math.max(0, contentSize.height),
      viewportWidth: Math.max(0, layoutMeasurement.width),
      viewportHeight: Math.max(0, layoutMeasurement.height),
      containerKey: "native-virtualized",
      offsetY: contentOffset.y,
      viewportMeasuredForKey: "native-virtualized",
      contentMeasuredForKey: "native-virtualized",
    };

    const nearBottom = isScrollEventNearBottom(event);
    onNearBottomChange(nearBottom);

    evaluateHistoryStart();

    if (
      !isUserScrollActiveRef.current &&
      programmaticScrollEventBudgetRef.current > 0 &&
      contentOffset.y <= 8
    ) {
      programmaticScrollEventBudgetRef.current -= 1;
    } else {
      programmaticScrollEventBudgetRef.current = 0;
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: nearBottom,
        scrollDelta: contentOffset.y - previousOffsetY,
      });
    }
  });

  const handleScrollBeginDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    clearPendingUserScrollEnd();
    isUserScrollActiveRef.current = true;
    scrollKeyboardDismiss.onScrollBeginDrag(event);
    bottomAnchorController.beginUserScroll();
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed !== historyStartPaginationStateRef.current) {
      historyStartPaginationStateRef.current = rearmed;
      setHistoryStartPaginationState(rearmed);
      evaluateHistoryStart();
    }
  });

  // Defer drag end so momentum can take ownership, but capture the terminal
  // gesture position now because layout may move the viewport in the meantime.
  const handleScrollEndDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const isNearBottom = isScrollEventNearBottom(event);
    scrollKeyboardDismiss.onScrollEndDrag(event);

    clearPendingUserScrollEnd();
    userScrollEndFrameIdRef.current = requestAnimationFrame(() => {
      userScrollEndFrameIdRef.current = null;
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    });
  });

  const handleMomentumScrollBegin = useStableEvent(() => {
    clearPendingUserScrollEnd();
  });

  const handleMomentumScrollEnd = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Android can emit momentum-end after a programmatic anchor correction.
      // Only momentum that still owns the user gesture may settle scroll intent.
      if (!isUserScrollActiveRef.current) {
        return;
      }
      const isNearBottom = isScrollEventNearBottom(event);
      clearPendingUserScrollEnd();
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    },
  );

  const handleListLayout = useStableEvent((event: LayoutChangeEvent) => {
    if (!isActive || suppressStickyRestickRef.current) {
      const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
      const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        containerKey: "native-virtualized",
        viewportWidth,
        viewportHeight,
        viewportMeasuredForKey: "native-virtualized",
      };
      return;
    }
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
    const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
    const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
    const viewportChanged =
      (previousViewportWidth > 0 && previousViewportWidth !== viewportWidth) ||
      (previousViewportHeight > 0 && previousViewportHeight !== viewportHeight);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      viewportWidth,
      viewportHeight,
      viewportMeasuredForKey: "native-virtualized",
    };
    if (viewportChanged) {
      markNativeViewportSettling();
    }
    bottomAnchorController.handleViewportMetricsChange({
      previousViewportWidth,
      viewportWidth,
      previousViewportHeight,
      viewportHeight,
    });
    evaluateHistoryStart();
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
    const nextContentHeight = Math.max(0, height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      contentHeight: nextContentHeight,
      contentMeasuredForKey: "native-virtualized",
    };
    if (!isActive || suppressStickyRestickRef.current) {
      return;
    }
    bottomAnchorController.handleContentSizeChange({
      previousContentHeight,
      contentHeight: nextContentHeight,
    });
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  });

  useEffect(() => {
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartSettle,
  ]);

  const renderItem = useStableEvent(
    ({ item, index }: ListRenderItemInfo<T>): ReactElement | null => {
      const rendered = renderHistoryMountedRow(item, index, historyItems);
      return (rendered ?? null) as ReactElement | null;
    },
  );

  const liveHeaderContent = useMemo(() => {
    // Stable render events read the latest expansion state; this revision makes
    // the memo invoke them again when that state changes.
    void liveHeadRowRevision;
    const liveHeadRows = segments.liveHead.map((item, index) => (
      <Fragment key={resolveKey(item, index)}>
        {renderLiveHeadRow(item, index, segments.liveHead)}
      </Fragment>
    ));
    const liveAuxiliary = renderLiveAuxiliary();
    if (
      liveHeadRows.length === 0 &&
      !liveAuxiliary &&
      !boundary.hasMountedHistory &&
      !boundary.hasVirtualizedHistory
    ) {
      return (listEmptyComponent ?? null) as ReactElement | null;
    }
    return (
      <Fragment>
        {liveHeadRows}
        {liveAuxiliary}
      </Fragment>
    );
  }, [
    boundary,
    listEmptyComponent,
    liveHeadRowRevision,
    renderLiveAuxiliary,
    renderLiveHeadRow,
    resolveKey,
    segments.liveHead,
  ]);

  const historyFooterContent = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    const historyStartSlot = (
      <View style={historyStartSlotStyle} testID="older-history-slot">
        {isLoadingOperation ? (
          <View testID="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </View>
    );
    // The inverted list renders the footer at the visual top; a caller-supplied
    // top slot (e.g. "Show earlier") sits above the history-start slot.
    return topSlot === undefined ? (
      historyStartSlot
    ) : (
      <View>
        {topSlot}
        {historyStartSlot}
      </View>
    );
  }, [historyStartPaginationState, topSlot]);

  // RN's FlatList strictMode keeps its internal renderItem wrapper stable when
  // data or the live header changes, preserving the row identities above.
  return (
    <FlatList
      ref={flatListRef}
      data={historyRows}
      renderItem={renderItem}
      keyExtractor={resolveKey}
      strictMode
      testID="agent-chat-scroll"
      nativeID="agent-chat-scroll-native-virtualized"
      ListHeaderComponent={liveHeaderContent ?? undefined}
      ListFooterComponent={historyFooterContent ?? undefined}
      contentContainerStyle={baseListContentContainerStyle}
      style={listStyle}
      onLayout={handleListLayout}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollBegin={handleMomentumScrollBegin}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      scrollEventThrottle={16}
      onContentSizeChange={handleContentSizeChange}
      maintainVisibleContentPosition={maintainVisibleContentPosition}
      initialNumToRender={40}
      maxToRenderPerBatch={40}
      updateCellsBatchingPeriod={0}
      windowSize={21}
      removeClippedSubviews={false}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator
      inverted
    />
  );
}

export function createNativeStreamStrategy(): StreamStrategy {
  const strategy = createStreamStrategy({
    render: (renderInput) => <NativeStreamViewport {...renderInput} strategy={strategy} />,
    orderTailReverse: true,
    orderHeadReverse: true,
    assistantTurnTraversalStep: 1,
    edgeSlot: "header",
    historyLiveBoundaryEdge: "first",
    liveHeadHistoryBoundaryEdge: "last",
    frameChildOrder: "footer-then-content",
    flatListInverted: true,
    overlayScrollbarInverted: true,
    maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 2,
      verificationRetryMode: "recheck",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) => input.offsetY <= input.threshold,
    getBottomOffset: () => 0,
  });
  return strategy;
}
