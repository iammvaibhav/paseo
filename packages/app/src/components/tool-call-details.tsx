import React, { useMemo, type ReactNode } from "react";
import {
  View,
  Text,
  ScrollView as RNScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Image as ExpoImage } from "expo-image";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { fleetToolLeafName } from "@getpaseo/protocol/tool-call-display";
import { buildLineDiff, parseUnifiedDiff, type DiffLine } from "@/utils/tool-call-parsers";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { hasMeaningfulToolCallDetail } from "@/utils/tool-call-detail-state";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { extensionFromPath, highlightToKeyedLines } from "@/utils/highlight-cache";
import { parseEvalToolCallDetail, type EvalCell, type EvalDetailModel } from "@/utils/eval-detail";
import { parseWebSearchToolCallDetail, type WebSearchDetailModel } from "@/utils/web-search-detail";
import { HighlightedLines } from "./highlighted-content";
import { DiffViewer } from "./diff-viewer";
import { getCodeInsets } from "./code-insets";
import { isWeb } from "@/constants/platform";
import { FleetToolCallDetailBody } from "@/screens/mission-control/fleet-tool-details";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

// expo-image is not a unistyles-aware component, so its box comes from the
// parent View and it only fills that box.
const EVAL_IMAGE_FILL = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;

// ---- Content Component ----

interface ToolCallDetailsContentProps {
  detail?: ToolCallDetail;
  errorText?: string;
  maxHeight?: number;
  fillAvailableHeight?: boolean;
  showLoadingSkeleton?: boolean;
  toolName?: string;
  resolveHost?: (host: string) => string;
}

interface DetailStyles {
  sectionFillStyle: StyleProp<ViewStyle>;
  codeBlockFillStyle: StyleProp<ViewStyle>;
  codeVerticalScrollStyle: StyleProp<ViewStyle>;
  scrollAreaFillStyle: StyleProp<ViewStyle>;
  scrollAreaStyle: StyleProp<ViewStyle>;
  jsonScrollCombined: StyleProp<ViewStyle>;
  jsonScrollErrorCombined: StyleProp<ViewStyle>;
  fullBleedContainerStyle: StyleProp<ViewStyle>;
  loadingContainerStyle: StyleProp<ViewStyle>;
  resolvedMaxHeight: number | undefined;
  shouldFill: boolean;
  isFullBleed: boolean;
}

function resolveIsFullBleed(detail: ToolCallDetail | undefined): boolean {
  return detail?.type === "edit" || detail?.type === "shell" || detail?.type === "write";
}

function resolveShouldFill(
  detail: ToolCallDetail | undefined,
  fillAvailableHeight: boolean,
  isEval: boolean,
): boolean {
  if (!fillAvailableHeight) return false;
  if (isEval) return true;
  const t = detail?.type;
  return t === "shell" || t === "edit" || t === "write" || t === "read" || t === "sub_agent";
}

function useDetailStyles(
  detail: ToolCallDetail | undefined,
  resolvedMaxHeight: number | undefined,
  fillAvailableHeight: boolean,
  isEval: boolean,
): DetailStyles {
  const isFullBleed = resolveIsFullBleed(detail);
  const shouldFill = resolveShouldFill(detail, fillAvailableHeight, isEval);
  const codeBlockStyle = isFullBleed ? styles.fullBleedBlock : styles.diffContainer;

  const sectionFillStyle = useMemo(
    () => [styles.section, shouldFill && styles.fillHeight],
    [shouldFill],
  );
  const codeBlockFillStyle = useMemo(
    () => [codeBlockStyle, shouldFill && styles.fillHeight],
    [codeBlockStyle, shouldFill],
  );
  const codeVerticalScrollStyle = useMemo(
    () => [
      styles.codeVerticalScroll,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaFillStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
    ],
    [resolvedMaxHeight],
  );
  const jsonScrollCombined = styles.jsonScroll;
  const jsonScrollErrorCombined = [styles.jsonScroll, styles.jsonScrollError];
  const fullBleedContainerStyle = useMemo(
    () => [
      isFullBleed ? styles.fullBleedContainer : styles.paddedContainer,
      shouldFill && styles.fillHeight,
    ],
    [isFullBleed, shouldFill],
  );
  const loadingContainerStyle = useMemo(
    () => [styles.loadingContainer, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );

  return {
    sectionFillStyle,
    codeBlockFillStyle,
    codeVerticalScrollStyle,
    scrollAreaFillStyle,
    scrollAreaStyle,
    jsonScrollCombined,
    jsonScrollErrorCombined,
    fullBleedContainerStyle,
    loadingContainerStyle,
    resolvedMaxHeight,
    shouldFill,
    isFullBleed,
  };
}

function useDiffLines(detail: ToolCallDetail | undefined): DiffLine[] | undefined {
  return useMemo(() => {
    if (!detail || detail.type !== "edit") return undefined;
    const diffLines = detail.unifiedDiff
      ? parseUnifiedDiff(detail.unifiedDiff)
      : buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
    return highlightDiffLines(diffLines, detail.filePath);
  }, [detail]);
}

interface ShellDetailProps {
  command: string;
  output: string | null | undefined;
  ds: DetailStyles;
}

function ShellDetailSection({ command, output, ds }: ShellDetailProps) {
  const normalizedCommand = command.replace(/\n+$/, "");
  const commandOutput = (output ?? "").replace(/^\n+/, "");
  const hasOutput = commandOutput.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                <Text style={styles.shellPrompt}>$ </Text>
                {normalizedCommand}
                {hasOutput ? `\n\n${commandOutput}` : ""}
              </Text>
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

function EvalCellMeta({ cell }: { cell: EvalCell }) {
  const parts: string[] = [];
  if (cell.durationMs !== null) {
    parts.push(
      cell.durationMs >= 1000 ? `${(cell.durationMs / 1000).toFixed(1)}s` : `${cell.durationMs}ms`,
    );
  }
  if (cell.exitCode !== null && cell.exitCode !== 0) {
    parts.push(`exit ${cell.exitCode}`);
  }
  if (cell.status === "running" || cell.status === "pending") {
    parts.push(cell.status);
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <Text style={[styles.evalMetaText, cell.status === "error" && styles.errorText]}>
      {parts.join(" · ")}
    </Text>
  );
}

function EvalCellBlock({ cell }: { cell: EvalCell }) {
  const keyedLines = useMemo(
    () => highlightToKeyedLines(cell.code, cell.highlightExtension),
    [cell.code, cell.highlightExtension],
  );
  return (
    <View style={styles.evalCell}>
      <View style={styles.evalCellHeader}>
        <Text style={styles.evalLanguageText}>{cell.languageLabel}</Text>
        {cell.title ? (
          <Text style={styles.evalTitleText} numberOfLines={1}>
            {cell.title}
          </Text>
        ) : null}
        <View style={styles.evalHeaderSpacer} />
        <EvalCellMeta cell={cell} />
      </View>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        contentContainerStyle={styles.codeHorizontalContent}
      >
        <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
          {keyedLines ? (
            <HighlightedLines lines={keyedLines} />
          ) : (
            <Text selectable style={styles.scrollText}>
              {cell.code}
            </Text>
          )}
        </View>
      </ScrollView>
      {cell.output ? (
        <View style={styles.evalOutput}>
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                {cell.output}
              </Text>
            </View>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function EvalDetailSection({ model, ds }: { model: EvalDetailModel; ds: DetailStyles }) {
  return (
    <View style={ds.sectionFillStyle}>
      <ScrollView
        style={ds.codeVerticalScrollStyle}
        contentContainerStyle={styles.evalStack}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {model.notice ? <Text style={styles.evalNoticeText}>{model.notice}</Text> : null}
        {model.cells.map((cell) => (
          <EvalCellBlock key={cell.key} cell={cell} />
        ))}
        {model.displayOutputs.map((output, position) => (
          <View key={output.key} style={styles.evalCell}>
            <View style={styles.evalCellHeader}>
              <Text style={styles.evalLanguageText}>{`display[${position + 1}]`}</Text>
            </View>
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.codeHorizontalContent}
            >
              <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
                <Text selectable style={styles.scrollText}>
                  {output.text}
                </Text>
              </View>
            </ScrollView>
          </View>
        ))}
        {model.images.map((image, position) => (
          <View key={image.key} style={styles.evalCell}>
            <View style={styles.evalCellHeader}>
              <Text style={styles.evalLanguageText}>{`image[${position + 1}]`}</Text>
            </View>
            <View style={styles.evalImage}>
              <ExpoImage
                source={image.source}
                style={EVAL_IMAGE_FILL}
                contentFit="contain"
                contentPosition="left"
              />
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
function WebSearchDetailSection({ model, ds }: { model: WebSearchDetailModel; ds: DetailStyles }) {
  return (
    <View style={ds.sectionFillStyle}>
      <ScrollView
        style={ds.codeVerticalScrollStyle}
        contentContainerStyle={styles.evalStack}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <View style={styles.evalCell}>
          <View style={styles.evalCellHeader}>
            <Text style={styles.evalLanguageText}>query</Text>
            <Text style={styles.evalTitleText} numberOfLines={2} selectable>
              {model.query}
            </Text>
          </View>
          {model.intent && model.intent !== model.query ? (
            <View style={styles.webSearchIntentBox}>
              <Text style={styles.evalLanguageText}>intent</Text>
              <Text style={styles.plainText} selectable>
                {model.intent}
              </Text>
            </View>
          ) : null}
        </View>

        {model.webResults && model.webResults.length > 0 ? (
          <View style={styles.evalCell}>
            <View style={styles.evalCellHeader}>
              <Text style={styles.evalLanguageText}>results</Text>
            </View>
            <View style={styles.webSearchResultsStack}>
              {model.webResults.map((result, idx) => (
                <View key={result.url || idx} style={styles.webSearchResultRow}>
                  <Text selectable style={styles.webResultTitle}>
                    {result.title || result.url}
                  </Text>
                  {result.url ? (
                    <Text selectable style={styles.webResultUrl}>
                      {result.url}
                    </Text>
                  ) : null}
                  {result.snippet ? (
                    <Text selectable style={styles.webResultSnippet}>
                      {result.snippet}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {model.content ? (
          <View style={styles.evalCell}>
            <View style={styles.evalCellHeader}>
              <Text style={styles.evalLanguageText}>content</Text>
            </View>
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.codeHorizontalContent}
            >
              <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
                <Text selectable style={styles.scrollText}>
                  {model.content}
                </Text>
              </View>
            </ScrollView>
          </View>
        ) : null}

        {model.annotations && model.annotations.length > 0 ? (
          <View style={styles.evalCell}>
            <View style={styles.evalCellHeader}>
              <Text style={styles.evalLanguageText}>annotations</Text>
            </View>
            <View style={styles.scrollContent}>
              <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
                {model.annotations.join("\n\n")}
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

interface WorktreeSetupDetailProps {
  log: string;
  branchName: string;
  worktreePath: string;
  ds: DetailStyles;
}

function WorktreeSetupDetailSection({
  log,
  branchName,
  worktreePath,
  ds,
}: WorktreeSetupDetailProps) {
  const setupLog = log.replace(/^\n+/, "");
  const hasLog = setupLog.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                {hasLog ? setupLog : `Preparing worktree ${branchName} at ${worktreePath}`}
              </Text>
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

function resolveSubAgentFallbackHeader(
  subAgentType: string | null | undefined,
  description: string | null | undefined,
  fallbackText: string,
): string {
  if (subAgentType && description) {
    return `${subAgentType}: ${description}`;
  }
  return subAgentType ?? description ?? fallbackText;
}

interface SubAgentDetailProps {
  log: string;
  childSessionId: string | null | undefined;
  subAgentType: string | null | undefined;
  description: string | null | undefined;
  ds: DetailStyles;
}

interface SubAgentActivityRow {
  index: number;
  toolName: string;
  summary?: string;
}

interface ParsedSubAgentLog {
  actions: SubAgentActivityRow[];
  remainingLog: string;
}

function parseBracketedSubAgentLine(line: string, index: number): SubAgentActivityRow | null {
  const match = line.match(/^\[([^\]]+)\](?:\s+(.*))?$/);
  if (!match) {
    return null;
  }
  const toolName = match[1]?.trim();
  if (!toolName) {
    return null;
  }
  const summary = match[2]?.trim();
  return {
    index,
    toolName,
    ...(summary ? { summary } : {}),
  };
}

function parseSubAgentLog(log: string): ParsedSubAgentLog {
  const actions: SubAgentActivityRow[] = [];
  const remainingLines: string[] = [];
  for (const line of log.replace(/^\n+/, "").split("\n")) {
    const normalizedLine = line.trim();
    if (!normalizedLine) {
      continue;
    }
    const parsedAction = parseBracketedSubAgentLine(normalizedLine, actions.length + 1);
    if (parsedAction) {
      actions.push(parsedAction);
    } else {
      remainingLines.push(line);
    }
  }
  return {
    actions,
    remainingLog: remainingLines.join("\n").replace(/^\n+/, ""),
  };
}

function SubAgentActionRow({ action }: { action: SubAgentActivityRow }) {
  return (
    <View style={styles.subAgentActionRow}>
      <Text selectable style={styles.subAgentActionTool}>
        {formatSubAgentToolName(action.toolName)}
      </Text>
      {action.summary ? (
        <Text selectable style={styles.subAgentActionSummary}>
          {action.summary}
        </Text>
      ) : null}
    </View>
  );
}

function formatSubAgentToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return toolName;
  }
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function SubAgentLogText({
  activityLog,
  fallbackHeader,
  hasActions,
}: {
  activityLog: string;
  fallbackHeader: string;
  hasActions: boolean;
}) {
  if (activityLog.length > 0) {
    return (
      <Text selectable style={styles.scrollText}>
        {activityLog}
      </Text>
    );
  }
  if (!hasActions) {
    return (
      <Text selectable style={styles.scrollText}>
        {fallbackHeader}
      </Text>
    );
  }
  return null;
}

function SubAgentDetailSection({
  log,
  childSessionId,
  subAgentType,
  description,
  ds,
}: SubAgentDetailProps) {
  const { t } = useTranslation();
  const { actions, remainingLog } = useMemo(() => parseSubAgentLog(log), [log]);
  const fallbackHeader = resolveSubAgentFallbackHeader(
    subAgentType,
    description,
    t("toolCallDetails.subAgentActivity"),
  );
  const hasActions = actions.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              {childSessionId ? (
                <Text selectable style={styles.subAgentSessionText}>
                  session {childSessionId}
                </Text>
              ) : null}
              {hasActions ? (
                <View style={styles.subAgentActions}>
                  {actions.map((action) => (
                    <SubAgentActionRow key={action.index} action={action} />
                  ))}
                </View>
              ) : null}
              <SubAgentLogText
                activityLog={remainingLog}
                fallbackHeader={fallbackHeader}
                hasActions={hasActions}
              />
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

interface EditDetailProps {
  diffLines: DiffLine[] | undefined;
  ds: DetailStyles;
}

function EditDetailSection({ diffLines, ds }: EditDetailProps) {
  return (
    <View style={ds.sectionFillStyle}>
      {diffLines ? (
        <View style={ds.codeBlockFillStyle}>
          <DiffViewer
            diffLines={diffLines}
            maxHeight={ds.resolvedMaxHeight}
            fillAvailableHeight={ds.shouldFill}
          />
        </View>
      ) : null}
    </View>
  );
}

interface ScrollableContentProps {
  content: string;
  ds: DetailStyles;
  wrapInSectionFill?: boolean;
  // Drives syntax highlighting (extension only) and, with startLine, a gutter.
  filePath?: string | null;
  startLine?: number;
}

function ScrollableTextSection({
  content,
  ds,
  wrapInSectionFill = true,
  filePath,
  startLine,
}: ScrollableContentProps) {
  const keyedLines = useMemo(
    () => (filePath ? highlightToKeyedLines(content, extensionFromPath(filePath)) : null),
    [content, filePath],
  );
  const body = (
    <ScrollView
      style={ds.scrollAreaFillStyle}
      contentContainerStyle={styles.scrollContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator={true}
    >
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={true}>
        {keyedLines ? (
          <HighlightedLines lines={keyedLines} startLine={startLine} />
        ) : (
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {content}
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
  if (!wrapInSectionFill) return body;
  return <View style={ds.sectionFillStyle}>{body}</View>;
}

interface FetchDetailProps {
  url: string;
  result: string | null | undefined;
  ds: DetailStyles;
}

function FetchDetailSection({ url, result, ds }: FetchDetailProps) {
  return (
    <View style={ds.sectionFillStyle}>
      <ScrollView
        style={ds.scrollAreaFillStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {result ? `${url}\n\n${result}` : url}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function ScrollablePlainTextSection({ text, ds }: { text: string; ds: DetailStyles }) {
  return (
    <View style={styles.section}>
      <ScrollView
        style={ds.scrollAreaStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <Text selectable style={styles.plainText}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

interface SearchDetail {
  query?: string;
  content?: string;
  filePaths?: string[];
  webResults?: { title: string; url: string }[];
  annotations?: string[];
}

function buildSearchSections(detail: SearchDetail, ds: DetailStyles): ReactNode[] {
  const out: ReactNode[] = [];
  if (detail.content) {
    out.push(
      <View key="search-content" style={styles.section}>
        <ScrollView
          style={ds.scrollAreaStyle}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
              {detail.content}
            </Text>
          </ScrollView>
        </ScrollView>
      </View>,
    );
  }
  if (detail.filePaths && detail.filePaths.length > 0) {
    out.push(
      <View key="search-files" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {detail.filePaths.join("\n")}
        </Text>
      </View>,
    );
  }
  if (detail.webResults && detail.webResults.length > 0) {
    out.push(
      <View key="search-web-results" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {detail.webResults.map((entry) => `${entry.title}\n${entry.url}`).join("\n\n")}
        </Text>
      </View>,
    );
  }
  if (detail.annotations && detail.annotations.length > 0) {
    out.push(
      <View key="search-annotations" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {detail.annotations.join("\n\n")}
        </Text>
      </View>,
    );
  }
  return out;
}

function serializeUnknownValue(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface UnknownDetail {
  input: unknown;
  output: unknown;
}

function buildUnknownSections(detail: UnknownDetail, ds: DetailStyles, t: TFunction): ReactNode[] {
  const plainInputText =
    typeof detail.input === "string" && detail.output === null ? detail.input : null;

  if (plainInputText !== null) {
    return [<ScrollablePlainTextSection key="unknown-plain-text" text={plainInputText} ds={ds} />];
  }

  const sectionsFromTopLevel = [
    { title: t("toolCallDetails.input"), value: detail.input },
    { title: t("toolCallDetails.output"), value: detail.output },
  ].filter((entry) =>
    hasMeaningfulToolCallDetail({
      type: "unknown",
      input: entry.value ?? null,
      output: null,
    }),
  );

  const out: ReactNode[] = [];
  for (const section of sectionsFromTopLevel) {
    const value = serializeUnknownValue(section.value);
    if (!value.length) {
      continue;
    }
    out.push(
      <View key={`${section.title}-header`} style={styles.groupHeader}>
        <Text style={styles.groupHeaderText}>{section.title}</Text>
      </View>,
    );
    out.push(
      <View key={`${section.title}-value`} style={styles.section}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          style={ds.jsonScrollCombined}
          contentContainerStyle={styles.jsonContent}
          showsHorizontalScrollIndicator={true}
        >
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {value}
          </Text>
        </ScrollView>
      </View>,
    );
  }
  return out;
}

function buildDetailSections(
  detail: ToolCallDetail | undefined,
  diffLines: DiffLine[] | undefined,
  ds: DetailStyles,
  t: TFunction,
  evalModel: EvalDetailModel | null,
  webSearchModel: WebSearchDetailModel | null,
): ReactNode[] {
  if (!detail) return [];
  if (evalModel) {
    return [<EvalDetailSection key="eval" model={evalModel} ds={ds} />];
  }
  if (webSearchModel) {
    return [<WebSearchDetailSection key="web-search" model={webSearchModel} ds={ds} />];
  }
  if (detail.type === "shell") {
    return [
      <ShellDetailSection key="shell" command={detail.command} output={detail.output} ds={ds} />,
    ];
  }
  if (detail.type === "worktree_setup") {
    return [
      <WorktreeSetupDetailSection
        key="worktree-setup"
        log={detail.log}
        branchName={detail.branchName}
        worktreePath={detail.worktreePath}
        ds={ds}
      />,
    ];
  }
  if (detail.type === "sub_agent") {
    return [
      <SubAgentDetailSection
        key="sub-agent"
        log={detail.log}
        childSessionId={detail.childSessionId}
        subAgentType={detail.subAgentType}
        description={detail.description}
        ds={ds}
      />,
    ];
  }
  if (detail.type === "edit") {
    return [<EditDetailSection key="edit" diffLines={diffLines} ds={ds} />];
  }
  if (detail.type === "write") {
    return [
      <View key="write" style={ds.sectionFillStyle}>
        {detail.content ? (
          <ScrollableTextSection
            content={detail.content}
            ds={ds}
            wrapInSectionFill={false}
            filePath={detail.filePath}
          />
        ) : null}
      </View>,
    ];
  }
  if (detail.type === "read") {
    if (!detail.content) return [];
    return [
      <ScrollableTextSection
        key="read"
        content={detail.content}
        ds={ds}
        filePath={detail.filePath}
        startLine={detail.offset ?? 1}
      />,
    ];
  }
  if (detail.type === "search") {
    return buildSearchSections(detail, ds);
  }
  if (detail.type === "fetch") {
    return [<FetchDetailSection key="fetch" url={detail.url} result={detail.result} ds={ds} />];
  }
  if (detail.type === "plain_text") {
    if (!detail.text) return [];
    return [<ScrollablePlainTextSection key="plain-text" text={detail.text} ds={ds} />];
  }
  if (detail.type === "unknown") {
    return buildUnknownSections(detail, ds, t);
  }
  return [];
}

function ErrorSection({ errorText, ds }: { errorText: string; ds: DetailStyles }) {
  const { t } = useTranslation();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, styles.errorText]}>{t("toolCallDetails.error")}</Text>
      <ScrollView
        horizontal
        nestedScrollEnabled
        style={ds.jsonScrollErrorCombined}
        contentContainerStyle={styles.jsonContent}
        showsHorizontalScrollIndicator={true}
      >
        <Text
          selectable
          style={[styles.scrollText, styles.errorText]}
          dataSet={CODE_SURFACE_DATASET}
        >
          {errorText}
        </Text>
      </ScrollView>
    </View>
  );
}

function LoadingSkeleton({ containerStyle }: { containerStyle: StyleProp<ViewStyle> }) {
  return (
    <View style={containerStyle}>
      <View style={styles.loadingLineWide} />
      <View style={styles.loadingLineMedium} />
      <View style={styles.loadingLineShort} />
    </View>
  );
}

export function ToolCallDetailsContent({
  detail,
  errorText,
  maxHeight,
  fillAvailableHeight = false,
  showLoadingSkeleton = false,
  toolName,
  resolveHost,
}: ToolCallDetailsContentProps) {
  const { t } = useTranslation();
  const resolvedMaxHeight = fillAvailableHeight ? undefined : (maxHeight ?? 300);
  const evalModel = useMemo(() => parseEvalToolCallDetail(detail), [detail]);
  const webSearchModel = useMemo(
    () => parseWebSearchToolCallDetail(detail, toolName),
    [detail, toolName],
  );
  const ds = useDetailStyles(
    detail,
    resolvedMaxHeight,
    fillAvailableHeight,
    evalModel !== null || webSearchModel !== null,
  );
  const diffLines = useDiffLines(detail);

  const sections: ReactNode[] = buildDetailSections(
    detail,
    diffLines,
    ds,
    t,
    evalModel,
    webSearchModel,
  );
  if (errorText) {
    sections.push(<ErrorSection key="error" errorText={errorText} ds={ds} />);
  }

  // The fleet body renders ONLY for fleet dispatch tools. A JSX element is
  // always truthy, so the old `toolName ? <FleetToolCallDetailBody/> : null`
  // guard let `fleetBody !== null` pass for every tool call and swallowed the
  // standard sections (thought cards expanded to an empty body).
  const fleetBody =
    toolName && fleetToolLeafName(toolName) ? (
      <FleetToolCallDetailBody toolName={toolName} detail={detail} resolveHost={resolveHost} />
    ) : null;
  if (fleetBody !== null) {
    return <View style={ds.fullBleedContainerStyle}>{fleetBody}</View>;
  }

  if (sections.length === 0) {
    if (showLoadingSkeleton) {
      return <LoadingSkeleton containerStyle={ds.loadingContainerStyle} />;
    }
    return <Text style={styles.emptyStateText}>{t("toolCallDetails.empty")}</Text>;
  }

  return <View style={ds.fullBleedContainerStyle}>{sections}</View>;
}

// ---- Styles ----

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    paddedContainer: {
      gap: theme.spacing[4],
      padding: 0,
    },
    fullBleedContainer: {
      gap: theme.spacing[2],
      padding: 0,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    groupHeaderText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.normal,
    },
    section: {
      gap: theme.spacing[2],
    },
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
    plainText: {
      fontFamily: theme.fontFamily.ui,
      fontSize: theme.fontSize.base,
      color: theme.colors.foreground,
      lineHeight: 22,
      overflowWrap: "anywhere",
    },
    sectionTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
      fontWeight: theme.fontWeight.semibold,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    rangeText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
    },
    diffContainer: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      overflow: "hidden",
      backgroundColor: theme.colors.surface2,
    },
    fullBleedBlock: {
      borderWidth: 0,
      borderRadius: 0,
      overflow: "hidden",
      backgroundColor: theme.colors.surface1,
    },
    codeVerticalScroll: {},
    codeVerticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    codeHorizontalContent: {
      paddingRight: insets.extraRight,
    },
    codeLine: {
      minWidth: "100%",
      paddingHorizontal: insets.padding,
      paddingVertical: insets.padding,
    },
    scrollArea: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    scrollContent: {
      padding: insets.padding,
    },
    scrollText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
          }
        : null),
    },
    shellPrompt: {
      color: theme.colors.foregroundMuted,
    },
    evalStack: {
      gap: theme.spacing[2],
      paddingBottom: insets.extraBottom,
    },
    evalCell: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      overflow: "hidden",
      backgroundColor: theme.colors.surface2,
    },
    evalCellHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    evalHeaderSpacer: {
      flex: 1,
    },
    evalLanguageText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foregroundMuted,
    },
    evalTitleText: {
      flexShrink: 1,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foreground,
    },
    evalMetaText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foregroundMuted,
    },
    evalOutput: {
      borderTopWidth: theme.borderWidth[1],
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    evalNoticeText: {
      fontSize: theme.fontSize.xs,
      color: theme.colors.foregroundMuted,
    },
    evalImage: {
      width: "100%",
      height: 220,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    webSearchIntentBox: {
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      gap: theme.spacing[1],
      borderTopWidth: theme.borderWidth[1],
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    webSearchResultsStack: {
      padding: theme.spacing[3],
      gap: theme.spacing[3],
    },
    webSearchResultRow: {
      gap: theme.spacing[1],
    },
    webResultTitle: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    webResultUrl: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foregroundMuted,
    },
    webResultSnippet: {
      fontSize: theme.fontSize.xs,
      color: theme.colors.foreground,
      lineHeight: 18,
    },
    subAgentSessionText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
      marginBottom: theme.spacing[2],
    },
    subAgentActions: {
      gap: theme.spacing[1],
      marginBottom: theme.spacing[2],
    },
    subAgentActionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    subAgentActionTool: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
    },
    subAgentActionSummary: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
    },
    jsonScroll: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    jsonScrollError: {
      borderColor: theme.colors.destructive,
    },
    jsonContent: {
      padding: insets.padding,
    },
    errorText: {
      color: theme.colors.destructive,
    },
    emptyStateText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      fontStyle: "italic",
    },
    loadingContainer: {
      gap: theme.spacing[2],
      padding: theme.spacing[3],
    },
    loadingLineWide: {
      height: 12,
      width: "100%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineMedium: {
      height: 12,
      width: "72%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineShort: {
      height: 12,
      width: "48%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
  };
});
