import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ScrollText } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { openHistoryAskAgentLink } from "@/history-ask/open-agent-link";
import { formatTimeAgo } from "@/utils/time";

const PASEO_SYSTEM_OPEN_TAG = "<paseo-system>";
const PASEO_SYSTEM_CLOSE_TAG = "</paseo-system>";
const FLEET_DIGEST_COUNT_PATTERN = /^Fleet digest:\s*(\d+)\s+events?\.?$/i;
const ENTRY_LINE_PATTERN = /^-\s*\[([^\]]*)\]\s*(.*)$/;
const DEEP_LINK_PATTERN = /paseo:\/\/\S+/;
const TITLE_HOST_PATTERN = /^(.*?)\s*\(([^)]*)\)\s*$/;

export interface PaseoSystemEntry {
  kind: string | null;
  headline: string;
  agentTitle: string | null;
  hostName: string | null;
  link: string | null;
  detail: string | null;
}

export interface PaseoSystemDigest {
  /** True when the body carries the "Fleet digest: N events." header. */
  isDigest: boolean;
  count: number | null;
  entries: PaseoSystemEntry[];
  /** Lines that belong to no digest entry (generic notification bodies). */
  bodyLines: string[];
}

/** Any user-role message starting with the paseo-system envelope must never render raw. */
export function isPaseoSystemMessage(text: string): boolean {
  return text.trimStart().startsWith(PASEO_SYSTEM_OPEN_TAG);
}

function findDeepLink(line: string): string | null {
  const match = line.match(DEEP_LINK_PATTERN);
  return match ? match[0] : null;
}

function parseTitleHost(value: string): { agentTitle: string | null; hostName: string | null } {
  const match = value.match(TITLE_HOST_PATTERN);
  if (!match) {
    return { agentTitle: value.trim(), hostName: null };
  }
  const agentTitle = match[1]?.trim();
  const hostName = match[2]?.trim();
  return {
    agentTitle: agentTitle || null,
    hostName: hostName || null,
  };
}

function parseEntryLine(kind: string, rest: string): PaseoSystemEntry {
  const parts = rest.split(/\s+[—–]\s+/).map((part) => part.trim());
  const headline = parts[0] ?? rest.trim();
  const titleHostPart = parts.slice(1).find((part) => !DEEP_LINK_PATTERN.test(part));
  const titleHost = titleHostPart
    ? parseTitleHost(titleHostPart)
    : { agentTitle: null, hostName: null };
  return {
    kind: kind || null,
    headline,
    agentTitle: titleHost.agentTitle,
    hostName: titleHost.hostName,
    link: findDeepLink(rest),
    detail: null,
  };
}

/** Data-derived React list key for digest entries; headlines alone may repeat. */
function paseoEntryListKey(entry: PaseoSystemEntry): string {
  return [entry.kind, entry.headline, entry.agentTitle, entry.hostName, entry.link, entry.detail]
    .map((part) => part ?? "")
    .join("\u0001");
}

/**
 * Parse a `<paseo-system>` envelope into digest entries.
 *
 * Digest body shape (produced by the daemon's digest builder):
 *
 *   Fleet digest: N events.
 *
 *   - [kind] headline — agentTitle (hostName) — paseo://h/{serverId}/agent/{agentId}
 *     detail continuation lines…
 *
 * Non-digest envelopes (chat mentions, schedule fires, notify-on-finish) carry
 * a plain reason body; those surface as `bodyLines`.
 */
export function parsePaseoSystemMessage(text: string): PaseoSystemDigest {
  const cleaned = text
    .trim()
    .replace(new RegExp(`^${PASEO_SYSTEM_OPEN_TAG}\\s*`, "i"), "")
    .replace(new RegExp(`\\s*${PASEO_SYSTEM_CLOSE_TAG}\\s*$`, "i"), "")
    .trim();
  const lines = cleaned.split("\n");
  const entries: PaseoSystemEntry[] = [];
  const bodyLines: string[] = [];
  let count: number | null = null;
  let currentEntry: PaseoSystemEntry | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (currentEntry === null) {
      const countMatch = trimmed.match(FLEET_DIGEST_COUNT_PATTERN);
      if (countMatch) {
        count = Number(countMatch[1]);
        continue;
      }
    }
    const entryMatch = trimmed.match(ENTRY_LINE_PATTERN);
    if (entryMatch) {
      currentEntry = parseEntryLine(entryMatch[1] ?? "", entryMatch[2] ?? "");
      entries.push(currentEntry);
      continue;
    }
    if (currentEntry) {
      currentEntry.detail = currentEntry.detail ? `${currentEntry.detail}\n${line}` : line;
      continue;
    }
    bodyLines.push(line);
  }

  return {
    isDigest: count !== null,
    count: count ?? (entries.length > 0 ? entries.length : null),
    entries,
    bodyLines,
  };
}

const ThemedScrollText = withUnistyles(ScrollText);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface PaseoSystemRowProps {
  text: string;
  timestamp: number;
}

export function PaseoSystemRow({ text, timestamp }: PaseoSystemRowProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => parsePaseoSystemMessage(text), [text]);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  const countLabel = parsed.count !== null ? `${parsed.count}` : "";
  const label = parsed.isDigest
    ? `Fleet digest · ${countLabel} event${parsed.count === 1 ? "" : "s"}`
    : "System notification";
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View style={styles.container}>
      <Pressable
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        style={styles.row}
        testID="mission-control-digest-row"
      >
        <ThemedScrollText size={14} uniProps={mutedIconMapping} />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.timestamp} numberOfLines={1}>
          {formatTimeAgo(new Date(timestamp))}
        </Text>
        <ThemedChevronDown
          size={14}
          uniProps={mutedIconMapping}
          style={[styles.chevron, expanded && styles.chevronExpanded]}
        />
      </Pressable>
      {expanded ? (
        <View style={styles.expanded}>
          {parsed.entries.map((entry) => (
            <PaseoSystemEntryRow key={paseoEntryListKey(entry)} entry={entry} />
          ))}
          {parsed.bodyLines.map((line) => (
            <Text key={line} style={styles.bodyLine}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PaseoSystemEntryRow({ entry }: { entry: PaseoSystemEntry }): ReactElement {
  return (
    <View style={styles.entryRow}>
      {entry.kind ? <Text style={styles.entryKind}>{entry.kind}</Text> : null}
      <View style={styles.entryBody}>
        <Text style={styles.entryHeadline}>{entry.headline}</Text>
        {entry.agentTitle || entry.hostName ? (
          <View style={styles.entryMetaRow}>
            <DigestEntryAgentChip entry={entry} />
            {entry.hostName ? (
              <Text style={styles.entryHost} numberOfLines={1}>
                {entry.hostName}
              </Text>
            ) : null}
          </View>
        ) : null}
        {entry.detail ? <Text style={styles.entryDetail}>{entry.detail}</Text> : null}
      </View>
    </View>
  );
}

function DigestEntryAgentChip({ entry }: { entry: PaseoSystemEntry }): ReactElement | null {
  const handleOpenAgent = useCallback(() => {
    if (entry.link) {
      openHistoryAskAgentLink(entry.link);
    }
  }, [entry.link]);
  if (!entry.link && !entry.agentTitle) {
    return null;
  }
  if (entry.link) {
    return (
      <Pressable
        onPress={handleOpenAgent}
        accessibilityRole="button"
        accessibilityLabel={`Open agent ${entry.agentTitle ?? "from digest"}`}
        style={styles.entryLinkChip}
      >
        <Text style={styles.entryLinkChipText} numberOfLines={1}>
          {entry.agentTitle ?? "Open agent"}
        </Text>
      </Pressable>
    );
  }
  return (
    <Text style={styles.entryAgent} numberOfLines={1}>
      {entry.agentTitle}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  label: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  timestamp: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  chevron: {
    transform: [{ rotate: "-90deg" }],
  },
  chevronExpanded: {
    transform: [{ rotate: "0deg" }],
  },
  expanded: {
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
  },
  bodyLine: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  entryRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  entryKind: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    paddingTop: 2,
  },
  entryBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  entryHeadline: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  entryMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  entryLinkChip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
  },
  entryLinkChipText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  entryAgent: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  entryHost: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  entryDetail: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
}));
