import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { syntaxTokenStyles } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

// Parsed JSON as a collapsible tree: keys, typed values, and one-line previews of
// collapsed objects, so a tool result reads as data instead of an escaped blob.

const ARRAY_PAGE = 50;
const PREVIEW_KEYS = ["name", "title", "id", "status", "type", "key"];
const PREVIEW_MAX = 80;

type JsonContainer = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is JsonContainer {
  return typeof value === "object" && value !== null;
}

function entriesOf(value: JsonContainer): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  if (value === undefined) return "undefined";
  return String(value);
}

function previewOf(value: JsonContainer): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? "1 item" : `${value.length} items`;
  }
  const entries = Object.entries(value);
  const picked = PREVIEW_KEYS.flatMap((key) => {
    const entry = value[key];
    return typeof entry === "string" || typeof entry === "number" ? [`${key}: ${entry}`] : [];
  }).slice(0, 2);
  const text = picked.length > 0 ? picked.join(", ") : `${entries.length} keys`;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

function JsonScalar({ value }: { value: unknown }): ReactElement {
  let style = syntaxTokenStyles.literal;
  if (typeof value === "string") style = syntaxTokenStyles.string;
  else if (typeof value === "number") style = syntaxTokenStyles.number;
  return <Text style={style}>{scalarText(value)}</Text>;
}

interface JsonEntryProps {
  label: string | null;
  value: unknown;
  depth: number;
  expandDepth: number;
}

function JsonEntry({ label, value, depth, expandDepth }: JsonEntryProps): ReactElement {
  if (!isContainer(value)) {
    return (
      <Text selectable style={styles.line}>
        {label !== null ? <Text style={syntaxTokenStyles.property}>{`${label}: `}</Text> : null}
        <JsonScalar value={value} />
      </Text>
    );
  }
  return <JsonBranch label={label} value={value} depth={depth} expandDepth={expandDepth} />;
}

function JsonChildren({
  value,
  depth,
  expandDepth,
}: {
  value: JsonContainer;
  depth: number;
  expandDepth: number;
}): ReactElement {
  const entries = entriesOf(value);
  const [showAll, setShowAll] = useState(false);
  const revealAll = useCallback(() => setShowAll(true), []);
  const visible = showAll ? entries : entries.slice(0, ARRAY_PAGE);
  const hidden = entries.length - visible.length;
  return (
    <>
      {visible.map(([key, entry]) => (
        <JsonEntry
          key={key}
          label={Array.isArray(value) ? `[${key}]` : key}
          value={entry}
          depth={depth}
          expandDepth={expandDepth}
        />
      ))}
      {hidden > 0 ? (
        <PressHighlight onPress={revealAll} accessibilityRole="button" style={styles.branchRow}>
          <Text style={styles.more}>{`Show ${hidden} more`}</Text>
        </PressHighlight>
      ) : null}
    </>
  );
}

function JsonBranch({
  label,
  value,
  depth,
  expandDepth,
}: Omit<JsonEntryProps, "value"> & { value: JsonContainer }): ReactElement {
  const isEmpty = entriesOf(value).length === 0;
  const [open, setOpen] = useState(depth < expandDepth && !isEmpty);
  const toggleOpen = useCallback(() => setOpen((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (isEmpty) {
    return (
      <Text selectable style={styles.line}>
        {label !== null ? <Text style={syntaxTokenStyles.property}>{`${label}: `}</Text> : null}
        <Text style={syntaxTokenStyles.punctuation}>{brackets.join("")}</Text>
      </Text>
    );
  }
  return (
    <View>
      <PressHighlight
        onPress={toggleOpen}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        style={styles.branchRow}
      >
        <Text style={styles.line}>
          <Text style={styles.chevron}>{open ? "▾ " : "▸ "}</Text>
          {label !== null ? <Text style={syntaxTokenStyles.property}>{`${label}: `}</Text> : null}
          <Text style={syntaxTokenStyles.punctuation}>
            {open ? brackets[0] : `${brackets[0]} ${previewOf(value)} ${brackets[1]}`}
          </Text>
        </Text>
      </PressHighlight>
      {open ? (
        <View style={styles.children}>
          <JsonChildren value={value} depth={depth + 1} expandDepth={expandDepth} />
        </View>
      ) : null}
    </View>
  );
}

interface JsonTreeProps {
  value: unknown;
  /** Levels expanded on first render, counted from the root's own entries. */
  expandDepth?: number;
  testID?: string;
}

export function JsonTree({ value, expandDepth = 2, testID }: JsonTreeProps): ReactElement {
  // A root object or array shows its entries directly: the outer brackets add nothing.
  return (
    <View style={styles.root} dataSet={CODE_SURFACE_DATASET} testID={testID}>
      {isContainer(value) && entriesOf(value).length > 0 ? (
        <JsonChildren value={value} depth={0} expandDepth={expandDepth} />
      ) : (
        <JsonEntry label={null} value={value} depth={0} expandDepth={expandDepth} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[0.5],
  },
  line: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  branchRow: {
    borderRadius: theme.borderRadius.base,
  },
  chevron: {
    color: theme.colors.foregroundMuted,
  },
  children: {
    marginLeft: theme.spacing[1.5],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    gap: theme.spacing[0.5],
  },
  more: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
}));
