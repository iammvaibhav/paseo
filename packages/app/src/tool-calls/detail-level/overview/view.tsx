import React, { Children, isValidElement, memo, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { EXPANDABLE_BADGE_ICON_SLOT, ExpandableBadge } from "@/components/message";
import { useIsCompactFormFactor } from "@/constants/layout";
import { type OverviewSummary, type OverviewToolCallGroup } from "./model";
import { OverviewToolCallGroupSheet } from "./sheet";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

const SUMMARY_SEPARATOR = " · ";

// "Thought 3 times · ran 2 commands · read 4 files": one segment per kind of work, in a
// fixed order, so runs read the same way down a transcript.
function useOverviewSummary(summary: OverviewSummary): string {
  const { t } = useTranslation();
  return useMemo(() => {
    const parts: string[] = [];
    const entries = [
      [summary.thoughtCount, "toolCallGroup.thoughts"],
      [summary.commandCount, "toolCallGroup.commands"],
      [summary.editedFileCount, "toolCallGroup.editedFiles"],
      [summary.readFileCount, "toolCallGroup.readFiles"],
      [summary.searchCount, "toolCallGroup.searches"],
      [summary.fetchCount, "toolCallGroup.fetches"],
      [summary.paseoCallCount, "toolCallGroup.paseoCalls"],
      [summary.otherToolCount, "toolCallGroup.otherTools"],
      [summary.failedCount, "toolCallGroup.failed"],
    ] as const;
    for (const [count, key] of entries) {
      if (count > 0) {
        parts.push(t(`${key}.${count === 1 ? "one" : "other"}`, { count }));
      }
    }
    const joined = parts.join(SUMMARY_SEPARATOR);
    return joined ? `${joined[0]?.toLocaleUpperCase()}${joined.slice(1)}` : joined;
  }, [summary, t]);
}

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: OverviewGroupProps) {
  const isCompact = useIsCompactFormFactor();
  const aggregateSummary = useOverviewSummary(group.summary);
  const toggle = useCallback(() => {
    onExpandedChange(group.run.id, !expanded);
  }, [expanded, group.run.id, onExpandedChange]);
  const close = useCallback(() => {
    onExpandedChange(group.run.id, false);
  }, [group.run.id, onExpandedChange]);
  // The steps hang off a rail under the summary's chevron, each on its own branch.
  const renderDetails = useCallback(() => {
    const steps = Children.toArray(children);
    return (
      <View style={styles.tree}>
        {steps.map((step, index) => (
          <View
            key={isValidElement(step) && step.key !== null ? step.key : index}
            style={styles.branch}
          >
            <View style={index === steps.length - 1 ? styles.railEnd : styles.rail} />
            <View style={styles.twig} />
            {step}
          </View>
        ))}
      </View>
    );
  }, [children]);

  if (isCompact) {
    return (
      <>
        <ExpandableBadge
          testID="tool-call-group"
          label={aggregateSummary}
          icon={ChevronRight}
          isLoading={group.isLoading}
          isExpanded={false}
          isLastInSequence={isLastInSequence}
          onToggle={toggle}
        />
        <OverviewToolCallGroupSheet visible={expanded} summary={aggregateSummary} onClose={close}>
          {children}
        </OverviewToolCallGroupSheet>
      </>
    );
  }

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={aggregateSummary}
      icon={ChevronRight}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      nestedDetails
    />
  );
});

// Badge geometry: a row's icon sits after the row padding (8) and is 22 wide, and the
// header line is centered 17px down (6 padding + 22 / 2).
const ROW_PADDING = 8;
const ICON_CENTER_X = ROW_PADDING + (EXPANDABLE_BADGE_ICON_SLOT - 4) / 2;
const HEADER_CENTER_Y = 17;
// Child badges pull out by 13 (their container margin); this puts their icon past the twig.
const BRANCH_INDENT = 25;
const TWIG_WIDTH = 14;

const styles = StyleSheet.create((theme) => ({
  tree: {
    marginLeft: ICON_CENTER_X,
  },
  branch: {
    position: "relative",
    paddingLeft: BRANCH_INDENT,
  },
  rail: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: theme.borderWidth[1],
    backgroundColor: theme.colors.surface3,
  },
  // The last step's rail stops at its twig, closing the tree.
  railEnd: {
    position: "absolute",
    left: 0,
    top: 0,
    height: HEADER_CENTER_Y + 1,
    width: theme.borderWidth[1],
    backgroundColor: theme.colors.surface3,
  },
  twig: {
    position: "absolute",
    left: 0,
    top: HEADER_CENTER_Y,
    width: TWIG_WIDTH,
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.surface3,
  },
}));
