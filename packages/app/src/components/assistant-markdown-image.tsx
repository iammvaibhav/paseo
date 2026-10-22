import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useAssistantImage } from "@/assistant-image/use-assistant-image";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { ASSISTANT_IMAGE_DEFAULT_ASPECT_RATIO } from "@/utils/assistant-image-metadata";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** An image referenced by path or URL, loaded through the host and opened in a lightbox. */
export function AssistantMarkdownImage({
  source,
  occurrenceKey,
  alt,
  hasLeadingContent,
  client,
  workspaceRoot,
  serverId,
}: {
  source: string;
  occurrenceKey: string;
  alt?: string;
  hasLeadingContent: boolean;
  client?: DaemonClient | null;
  workspaceRoot?: string;
  serverId?: string;
}) {
  const { t } = useTranslation();
  const [viewerOpen, setViewerOpen] = useState(false);
  const openViewer = useCallback(() => setViewerOpen(true), []);
  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => ({
      marginTop: hasLeadingContent ? 16 : 0,
      marginBottom: 0,
    }),
    [hasLeadingContent],
  );
  const image = useAssistantImage({
    source,
    occurrenceKey,
    client,
    workspaceRoot,
    serverId,
  });
  const binding = image.status === "failed" ? null : image.binding;
  const aspectRatio = image.status === "failed" ? null : image.aspectRatio;
  const imageUri = binding?.uri ?? "";
  const imageSource = useMemo(() => ({ uri: imageUri }), [imageUri]);
  const frameStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.imageFrame, containerStyle],
    [containerStyle],
  );
  const imageSizeStyle = useMemo<ViewStyle>(() => {
    if (image.status === "failed") return { height: 160 };
    return { aspectRatio: aspectRatio ?? ASSISTANT_IMAGE_DEFAULT_ASPECT_RATIO };
  }, [aspectRatio, image.status]);
  const surfaceStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.imageSurface, imageSizeStyle],
    [imageSizeStyle],
  );
  const lightboxSource = useMemo<ImageLightboxSource | null>(() => {
    if (!viewerOpen || !imageUri) return null;
    return {
      type: "uri",
      uri: imageUri,
      contentSize: aspectRatio ? { width: aspectRatio, height: 1 } : undefined,
    };
  }, [aspectRatio, imageUri, viewerOpen]);

  const stateFrameStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.imageFrame, containerStyle, imageSizeStyle, styles.imageState],
    [containerStyle, imageSizeStyle],
  );

  if (image.status === "failed") {
    return (
      <View style={stateFrameStyle}>
        <Text style={styles.imageErrorText}>{image.message}</Text>
      </View>
    );
  }

  if (!binding) {
    return (
      <View style={stateFrameStyle}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  return (
    <View style={frameStyle}>
      <Pressable
        accessibilityLabel={t("composer.attachments.openImage")}
        accessibilityRole="button"
        disabled={image.status !== "loaded"}
        onPress={openViewer}
        style={surfaceStyle}
      >
        <View style={styles.image} accessibilityRole="image" accessibilityLabel={alt}>
          <Image
            ref={binding.onRef}
            source={imageSource}
            style={styles.image}
            resizeMode="contain"
            onLoad={binding.onLoad}
            onError={binding.onError}
          />
          {image.status === "loading" ? (
            <View pointerEvents="none" style={styles.imageLoadingOverlay}>
              <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
            </View>
          ) : null}
        </View>
      </Pressable>
      <AttachmentLightbox source={lightboxSource} onClose={closeViewer} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  imageFrame: {
    width: "100%",
    minHeight: 160,
    marginHorizontal: -theme.spacing[1],
  },
  imageSurface: {
    width: "100%",
    overflow: "hidden",
    position: "relative",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  imageLoadingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  imageState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[2],
  },
  imageErrorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
