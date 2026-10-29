import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import { useStableEvent } from "@/hooks/use-stable-event";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { density, resolveDensity } from "@/styles/density";
import { MarkdownBlockStack } from "./block-stack";
import { splitDetailsBlocks, type MarkdownDetailsSegment } from "./details";
import { normalizeMathDelimiters } from "./math";
import { WEB_RENDERERS } from "./renderers";
import { createMarkdownStyles } from "./styles";
import { PENDING_MARKDOWN_IMAGE } from "./source";
import { splitStreamingMarkdown } from "./streaming";
import { useMarkdownSource, type MarkdownImageContext } from "./images";

import { MermaidFence, MermaidStreamingContext, splitMermaidFences } from "./fence/mermaid";

const ThemedMarkdown = withUnistyles(EnrichedMarkdownText);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };
const MD4C_FLAGS_WITH_MATH = { ...MD4C_FLAGS, latexMath: true };

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Reading the breakpoint here makes Unistyles restyle the text when the layout crosses it.
const markdownStyle =
  (compact: boolean, muted = false) =>
  (theme: Theme, rt: { breakpoint?: string }) =>
    createMarkdownStyles(theme, {
      compact,
      muted,
      blockGap: resolveDensity(rt, density.blockGap),
    });
const regularStyle = markdownStyle(false);
const compactStyle = markdownStyle(true);
const compactMutedStyle = markdownStyle(true, true);

function pickMarkdownStyle(compact: boolean, muted: boolean) {
  if (!compact) return regularStyle;
  return muted ? compactMutedStyle : compactStyle;
}

export interface MarkdownRendererProps extends MarkdownImageContext {
  text: string;
  compact?: boolean;
  /** Muted text colour. Compact surfaces only. */
  muted?: boolean;
  selectable?: boolean;
  streaming?: boolean;
  /** Render TeX between `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. Web only; native shows the source. */
  math?: boolean;
  onLinkPress?: (url: string) => unknown;
}

/** All Markdown surfaces share the same engine and source adaptation. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  const segments = useMemo(() => splitDetailsBlocks(props.text), [props.text]);
  if (segments.length === 1 && segments[0]?.kind === "markdown") {
    return <MarkdownText {...props} />;
  }
  const last = segments.length - 1;
  return (
    <MarkdownBlockStack>
      {segments.map((segment, index) =>
        segment.kind === "details" ? (
          <MarkdownDetails
            key={segment.id}
            {...props}
            segment={segment}
            streaming={props.streaming && index === last}
          />
        ) : (
          <MarkdownText
            key={segment.id}
            {...props}
            text={segment.source}
            streaming={props.streaming && index === last}
          />
        ),
      )}
    </MarkdownBlockStack>
  );
});

function MarkdownDetails({
  segment,
  ...props
}: MarkdownRendererProps & { segment: MarkdownDetailsSegment }) {
  const [open, setOpen] = useState(segment.open);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View style={detailsStyles.container}>
      <PressHighlight
        style={detailsStyles.summaryRow}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
      >
        {open ? (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
        )}
        <Text style={detailsStyles.summaryText}>{segment.summary}</Text>
      </PressHighlight>
      {open ? (
        <View style={detailsStyles.body}>
          <MarkdownRenderer {...props} text={segment.body} />
        </View>
      ) : null}
    </View>
  );
}

const MarkdownText = memo(function MarkdownText(props: MarkdownRendererProps) {
  const streaming = !isWeb && !!props.streaming;
  // Only completed lines affect block closure. Do not run mdast on every reveal frame.
  const completeLines = streaming ? props.text.slice(0, props.text.lastIndexOf("\n") + 1) : "";
  const boundary = useMemo(
    () => splitStreamingMarkdown(completeLines, true).head.length,
    [completeLines],
  );
  if (!streaming || boundary === 0) return <MarkdownPart {...props} />;
  return (
    <MarkdownBlockStack>
      <MarkdownPart {...props} text={props.text.slice(0, boundary)} />
      <MarkdownPart {...props} text={props.text.slice(boundary)} />
    </MarkdownBlockStack>
  );
});

const MarkdownPart = memo(function MarkdownPart({
  text,
  compact = false,
  muted = false,
  selectable = true,
  streaming = false,
  math = false,
  onLinkPress,
  ...imageContext
}: MarkdownRendererProps) {
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const client =
    imageContext.client ??
    (environment.client?.readFile
      ? { readFile: environment.client.readFile.bind(environment.client) }
      : undefined);
  const renderMath = math;
  const mathSource = useMemo(
    () => (renderMath ? normalizeMathDelimiters(text) : text),
    [renderMath, text],
  );
  const { markdown, imageSources, linkRecognition, linkSource } = useMarkdownSource(mathSource, {
    workspaceRoot: environment.workspaceRoot,
    serverId: environment.serverId,
    ...imageContext,
    client,
  });
  const [image, setImage] = useState<ImageLightboxSource | null>(null);
  const pressLink = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    const source = linkSource(url, sourceType);
    if (onLinkPress && !actions.canResolveFile(source)) onLinkPress(url);
    else actions.open(source, "preferred");
  });
  const pressImage = useStableEvent(({ url }: { url: string }) => {
    if (url !== PENDING_MARKDOWN_IMAGE) setImage({ type: "uri", uri: url });
  });
  const closeImage = useStableEvent(() => setImage(null));
  const segments = useMemo(
    () =>
      isWeb ? [{ kind: "markdown", id: "0", source: markdown }] : splitMermaidFences(markdown),
    [markdown],
  );
  return (
    <MermaidStreamingContext.Provider value={streaming}>
      <MarkdownBlockStack imageSources={imageSources}>
        {segments.map((segment) =>
          segment.kind === "mermaid" ? (
            <MermaidFence key={`${segment.kind}:${segment.id}`} code={segment.source} />
          ) : (
            <ThemedMarkdown
              key={`${segment.kind}:${segment.id}`}
              markdown={segment.source}
              uniProps={pickMarkdownStyle(compact, muted)}
              flavor="github"
              selectable={selectable}
              md4cFlags={renderMath ? MD4C_FLAGS_WITH_MATH : MD4C_FLAGS}
              linkRecognition={linkRecognition}
              enableTaskListItemToggle={false}
              enableLinkPreview={false}
              enableBlockContextMenu={false}
              // JS reveal owns pacing; native fade animation is a separate experiment.
              streamingAnimation={false}
              onLinkPress={pressLink}
              onImagePress={pressImage}
              renderers={isWeb ? WEB_RENDERERS : undefined}
            />
          ),
        )}
      </MarkdownBlockStack>
      {image ? <AttachmentLightbox source={image} onClose={closeImage} /> : null}
    </MermaidStreamingContext.Provider>
  );
});

const detailsStyles = StyleSheet.create((theme) => ({
  container: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  summaryText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
  },
  body: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
}));
