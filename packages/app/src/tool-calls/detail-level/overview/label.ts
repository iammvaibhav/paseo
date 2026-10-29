import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { OverviewSummary } from "./model";

const SUMMARY_SEPARATOR = " · ";

/**
 * One line of what a stretch of agent work did, such as "Thought 3 times · ran 2 commands ·
 * read 4 files": one segment per kind of work, in a fixed order, so runs read the same way
 * down a transcript. Leading parts come first, for summaries that count more than tool calls.
 */
export function useOverviewSummaryLabel(
  summary: OverviewSummary,
  leadingParts: readonly string[] = [],
): string {
  const { t } = useTranslation();
  return useMemo(() => {
    const parts = [...leadingParts];
    const countParts = (entries: ReadonlyArray<readonly [number, string]>) => {
      for (const [count, key] of entries) {
        if (count > 0) {
          parts.push(t(`${key}.${count === 1 ? "one" : "other"}`, { count }));
        }
      }
    };
    countParts([
      [summary.thoughtCount, "toolCallGroup.thoughts"],
      [summary.commandCount, "toolCallGroup.commands"],
      [summary.editedFileCount, "toolCallGroup.editedFiles"],
      [summary.readFileCount, "toolCallGroup.readFiles"],
      [summary.searchCount, "toolCallGroup.searches"],
      [summary.fetchCount, "toolCallGroup.fetches"],
    ]);
    for (const [action, count] of Object.entries(summary.paseoActions)) {
      parts.push(
        count === 1 ? action.toLocaleLowerCase() : `${action.toLocaleLowerCase()} ×${count}`,
      );
    }
    countParts([
      [summary.otherToolCount, "toolCallGroup.otherTools"],
      [summary.failedCount, "toolCallGroup.failed"],
    ]);
    const joined = parts.join(SUMMARY_SEPARATOR);
    return joined ? `${joined[0]?.toLocaleUpperCase()}${joined.slice(1)}` : joined;
  }, [leadingParts, summary, t]);
}
