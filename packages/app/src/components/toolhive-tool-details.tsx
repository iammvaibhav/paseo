import { useMemo, type ReactElement } from "react";
import {
  ScrollView as RNScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { highlightToKeyedLines } from "@/utils/highlight-cache";
import type {
  ToolHiveDetailModel,
  ToolHiveFoundTool,
  ToolHiveResult,
  ToolHiveToolName,
} from "@/utils/toolhive-detail";
import { HighlightedLines } from "./highlighted-content";
import { JsonTree } from "./json-tree";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

interface ToolHiveDetailProps {
  model: ToolHiveDetailModel;
  fillStyle: StyleProp<ViewStyle>;
  scrollStyle: StyleProp<ViewStyle>;
}

/** Body of a ToolHive find_tool / call_tool / execute_tool_script row. */
export function ToolHiveDetail({ model, fillStyle, scrollStyle }: ToolHiveDetailProps) {
  return (
    <View style={fillStyle} testID={`toolhive-${model.op}-details`}>
      <ScrollView
        style={scrollStyle}
        contentContainerStyle={styles.stack}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {model.op === "find" ? <FindBody model={model} /> : null}
        {model.op === "call" ? <CallBody model={model} /> : null}
        {model.op === "script" ? <ScriptBody model={model} /> : null}
      </ScrollView>
    </View>
  );
}

function ToolName({ name }: { name: ToolHiveToolName }) {
  return (
    <View style={styles.toolName}>
      {name.server ? <Text style={styles.serverBadge}>{name.server}</Text> : null}
      <Text selectable style={styles.toolNameText}>
        {name.tool}
      </Text>
    </View>
  );
}

function Reason({ text }: { text: string | undefined }) {
  return text ? (
    <Text selectable style={styles.reason}>
      {text}
    </Text>
  ) : null;
}

function Group({
  title,
  children,
  tone,
}: {
  title: string;
  children: ReactElement;
  tone?: "error";
}) {
  return (
    <View style={styles.group}>
      <Text style={[styles.groupTitle, tone === "error" && styles.errorText]}>{title}</Text>
      {children}
    </View>
  );
}

function FindBody({ model }: { model: Extract<ToolHiveDetailModel, { op: "find" }> }) {
  const metrics = [
    model.tools.length > 0 ? `${model.tools.length} tools` : undefined,
    model.savingsPercent !== undefined
      ? `${Math.round(model.savingsPercent)}% fewer tokens than listing every tool`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return (
    <>
      <View style={styles.group}>
        {model.keywords.length > 0 ? (
          <View style={styles.chips}>
            {model.keywords.map((keyword) => (
              <Text key={keyword} style={styles.chip}>
                {keyword}
              </Text>
            ))}
          </View>
        ) : null}
        {metrics.length > 0 ? <Text style={styles.meta}>{metrics.join(" · ")}</Text> : null}
      </View>
      {model.tools.map((tool) => (
        <FoundToolRow key={tool.key} tool={tool} />
      ))}
      <ResultGroup result={model.result} />
    </>
  );
}

function FoundToolRow({ tool }: { tool: ToolHiveFoundTool }) {
  return (
    <View style={styles.foundTool}>
      <ToolName name={tool.name} />
      {tool.title || tool.description ? (
        <Text selectable style={styles.description} numberOfLines={3}>
          {[tool.title, tool.description].filter(Boolean).join(" — ")}
        </Text>
      ) : null}
      {tool.params.length > 0 ? (
        <Text selectable style={styles.params}>
          {tool.params.map((param, index) => (
            <Text key={param.name}>
              {index > 0 ? "  " : ""}
              <Text style={param.required ? styles.requiredParam : undefined}>{param.name}</Text>
              {param.type ? <Text style={styles.paramType}>{`: ${param.type}`}</Text> : null}
            </Text>
          ))}
        </Text>
      ) : null}
    </View>
  );
}

function CallBody({ model }: { model: Extract<ToolHiveDetailModel, { op: "call" }> }) {
  return (
    <>
      <Reason text={model.reason} />
      <ValueGroup title="Parameters" value={model.parameters} />
      <ResultGroup result={model.result} />
    </>
  );
}

function ScriptBody({ model }: { model: Extract<ToolHiveDetailModel, { op: "script" }> }) {
  return (
    <>
      {model.script ? (
        <Group title="Script">
          <CodeBlock code={model.script} />
        </Group>
      ) : null}
      <ValueGroup title="Data" value={model.data} />
      <ResultGroup result={model.result} />
    </>
  );
}

function ValueGroup({ title, value }: { title: string; value: unknown }) {
  const empty =
    value === null ||
    value === undefined ||
    (typeof value === "object" && Object.keys(value).length === 0);
  if (empty) return null;
  return (
    <Group title={title}>
      <JsonTree value={value} />
    </Group>
  );
}

function ResultGroup({ result }: { result: ToolHiveResult | null }) {
  if (!result) return null;
  return (
    <Group title={result.isError ? "Error" : "Result"} tone={result.isError ? "error" : undefined}>
      <View style={styles.resultBody}>
        {result.header.length > 0 ? (
          <View style={styles.chips}>
            {result.header.map((entry) => (
              <Text key={entry.key} selectable style={styles.chip} numberOfLines={1}>
                {`${entry.key} ${entry.value}`}
              </Text>
            ))}
          </View>
        ) : null}
        {result.isJson ? (
          <JsonTree value={result.value} />
        ) : (
          <Text selectable style={[styles.plainResult, result.isError && styles.errorText]}>
            {String(result.value)}
          </Text>
        )}
      </View>
    </Group>
  );
}

function CodeBlock({ code }: { code: string }) {
  // Starlark is Python syntax.
  const lines = useMemo(() => highlightToKeyedLines(code, "py"), [code]);
  return (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
      <View style={styles.code} dataSet={CODE_SURFACE_DATASET}>
        {lines ? (
          <HighlightedLines lines={lines} />
        ) : (
          <Text selectable style={styles.plainResult}>
            {code}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  group: {
    gap: theme.spacing[1.5],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  toolName: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  serverBadge: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    overflow: "hidden",
  },
  toolNameText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  reason: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  chip: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    overflow: "hidden",
    maxWidth: "100%",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  foundTool: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  params: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  requiredParam: {
    color: theme.colors.foreground,
  },
  paramType: {
    color: theme.colors.foregroundMuted,
  },
  resultBody: {
    gap: theme.spacing[2],
  },
  plainResult: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  code: {
    paddingVertical: theme.spacing[1],
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
