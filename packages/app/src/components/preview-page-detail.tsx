import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import type {
  PreviewPageConsoleMessage,
  PreviewPageDetailModel,
} from "@/utils/preview-page-detail";

/** Screenshots taller than this scroll inside the detail instead of growing the transcript. */
const SCREENSHOT_MAX_HEIGHT = 480;

/**
 * A `preview_page` call: the screenshot the agent looked at, what the page logged, and its
 * measured size. The page source is shown after this by the caller.
 */
export function PreviewPageDetail({ model }: { model: PreviewPageDetailModel }) {
  const { t } = useTranslation();
  const [viewerOpen, setViewerOpen] = useState(false);
  const openViewer = useCallback(() => setViewerOpen(true), []);
  const closeViewer = useCallback(() => setViewerOpen(false), []);

  const aspectRatio =
    model.width && model.capturedHeight ? model.width / model.capturedHeight : undefined;
  const imageStyle = useMemo(
    () => [styles.screenshot, aspectRatio ? { aspectRatio } : styles.screenshotFallback],
    [aspectRatio],
  );
  const imageSource = useMemo(
    () => (model.screenshotUri ? { uri: model.screenshotUri } : null),
    [model.screenshotUri],
  );
  const lightboxSource = useMemo<ImageLightboxSource | null>(() => {
    if (!viewerOpen || !model.screenshotUri) return null;
    return {
      type: "uri",
      uri: model.screenshotUri,
      contentSize:
        model.width && model.capturedHeight
          ? { width: model.width, height: model.capturedHeight }
          : undefined,
    };
  }, [model.capturedHeight, model.screenshotUri, model.width, viewerOpen]);

  const meta = [
    model.url,
    model.width ? t("toolCallDetails.previewPage.width", { width: model.width }) : null,
    model.contentHeight
      ? t("toolCallDetails.previewPage.pageHeight", { height: model.contentHeight })
      : null,
    model.capturedHeight && model.contentHeight && model.capturedHeight < model.contentHeight
      ? t("toolCallDetails.previewPage.captured", { height: model.capturedHeight })
      : null,
    model.appearance,
  ].filter((part): part is string => Boolean(part));

  return (
    <View style={styles.container}>
      {meta.length > 0 ? <Text style={styles.meta}>{meta.join(" · ")}</Text> : null}
      {imageSource ? (
        <ScrollView style={styles.screenshotScroll} nestedScrollEnabled>
          <Pressable
            onPress={openViewer}
            accessibilityRole="button"
            accessibilityLabel={t("toolCallDetails.previewPage.openScreenshot")}
          >
            <Image source={imageSource} style={imageStyle} resizeMode="contain" />
          </Pressable>
        </ScrollView>
      ) : null}
      {model.message ? <Text style={styles.message}>{model.message}</Text> : null}
      {model.screenshotUri || model.consoleMessages.length > 0 ? (
        <View style={styles.console}>
          <Text style={styles.sectionTitle}>
            {t("toolCallDetails.previewPage.console", { count: model.consoleMessages.length })}
          </Text>
          {model.consoleMessages.length === 0 ? (
            <Text style={styles.empty}>{t("toolCallDetails.previewPage.noConsole")}</Text>
          ) : (
            withOccurrenceKeys(model.consoleMessages).map(({ key, message }) => (
              <View key={key} style={styles.consoleRow}>
                <Text style={[styles.level, levelStyle(message.level)]}>{message.level}</Text>
                <Text selectable style={styles.consoleText} dataSet={CODE_SURFACE_DATASET}>
                  {message.text}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}
      <AttachmentLightbox source={lightboxSource} onClose={closeViewer} />
    </View>
  );
}

/** Data-derived keys; the same message can be logged more than once. */
function withOccurrenceKeys(messages: readonly PreviewPageConsoleMessage[]) {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const base = `${message.level}\u0001${message.text}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}\u0001${occurrence}`, message };
  });
}

function levelStyle(level: string) {
  if (level === "error" || level === "pageerror") return styles.levelError;
  if (level === "warning" || level === "warn") return styles.levelWarning;
  return null;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  screenshotScroll: {
    maxHeight: SCREENSHOT_MAX_HEIGHT,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  screenshot: {
    width: "100%",
  },
  screenshotFallback: {
    height: 320,
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  console: {
    gap: theme.spacing[1],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  consoleRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  level: {
    minWidth: 56,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
  levelError: {
    color: theme.colors.statusDanger,
  },
  levelWarning: {
    color: theme.colors.statusWarning,
  },
  consoleText: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
}));
