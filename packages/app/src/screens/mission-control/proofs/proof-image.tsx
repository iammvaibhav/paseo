import React, { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Image as ExpoImage } from "expo-image";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";
import { useProofMedia } from "./proof-media";

const EVAL_IMAGE_FILL = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;

/** Image proof → the existing image pipeline (expo-image from a data URI). */
export function ProofImage({
  serverId,
  proof,
}: {
  serverId: string;
  proof: MissionControlProof;
}): ReactElement | null {
  const path = proof.path ?? "";
  const media = useProofMedia({ serverId, path });
  const imageSource = useMemo(
    () =>
      media.status === "ready" ? { uri: `data:${media.mimeType};base64,${media.data}` } : null,
    [media],
  );
  if (!path) {
    return null;
  }

  if (media.status === "loading" || media.status === "idle") {
    return <Text style={styles.statusText}>Loading image…</Text>;
  }
  if (media.status === "error") {
    return <Text style={styles.errorText}>{media.error}</Text>;
  }
  return (
    <View style={styles.frame}>
      {/* expo-image is not unistyles-aware; the parent View owns the box. */}
      <ExpoImage
        source={imageSource}
        style={EVAL_IMAGE_FILL}
        contentFit="contain"
        accessibilityLabel={media.fileName}
        testID="mission-control-proof-image"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    height: 240,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  statusText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
}));
