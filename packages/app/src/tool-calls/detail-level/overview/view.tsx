import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
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
  // The steps hang off a rail under the summary, like a tree.
  const renderDetails = useCallback(() => <View style={styles.rail}>{children}</View>, [children]);

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
      icon={expanded ? ChevronDown : ChevronRight}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    marginLeft: 6,
    paddingLeft: theme.spacing[3],
    paddingTop: theme.spacing[1],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.surface3,
  },
}));
