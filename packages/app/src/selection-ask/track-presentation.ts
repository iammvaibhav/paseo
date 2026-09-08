import type { TFunction } from "i18next";
import type { ComposerTrackPillSegment } from "@/composer/tracks";
import {
  aggregateSidebarStateBuckets,
  deriveSidebarStateBucket,
  type SidebarStateBucket,
} from "@/utils/sidebar-agent-state";
import type { Agent } from "@/stores/session-store";

/**
 * The one state the collapsed pill can show. Same collapse as the subagents
 * track: the most urgent child wins, and a finished set is not worth a colour.
 */
export function aggregateAskStatusBucket(asks: readonly Agent[]): SidebarStateBucket | null {
  if (asks.length === 0) {
    return null;
  }
  const buckets = asks.map((ask) =>
    deriveSidebarStateBucket({
      bucket: ask.bucket,
      status: ask.status,
      pendingPermissionCount: ask.pendingPermissions.length,
      attentionReason: ask.attentionReason,
      stoppedBy: ask.stoppedBy,
    }),
  );
  const aggregate = aggregateSidebarStateBuckets(buckets);
  return aggregate === "done" ? null : aggregate;
}

export function resolveAskTitle(ask: Agent): string {
  const title = ask.title?.trim();
  if (title) {
    return title;
  }
  const name = ask.name?.trim();
  if (name) {
    return name;
  }
  return "Ask";
}

export interface AskPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

export function buildAskPillPresentation(
  t: TFunction,
  asks: readonly Agent[],
): AskPillPresentation {
  const label =
    asks.length === 1
      ? t("selectionAsks.pillLabelOne")
      : t("selectionAsks.pillLabelMany", { count: asks.length });
  const bucket = aggregateAskStatusBucket(asks);
  return {
    segments: [{ bucket, text: label }],
    accessibilityLabel: label,
  };
}
