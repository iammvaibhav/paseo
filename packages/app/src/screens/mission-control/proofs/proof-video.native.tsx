import React, { useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { File, Paths } from "expo-file-system";
import { VideoView, useVideoPlayer } from "expo-video";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";
import { useProofMedia } from "./proof-media";

/** Extension for a proof mime type; used to name the cached local file. */
function extensionForMimeType(mimeType: string): string {
  const match = /^video\/([a-z0-9.+-]+)$/.exec(mimeType);
  const candidate = match?.[1] ?? "mp4";
  return candidate === "quicktime" ? "mov" : candidate;
}

/**
 * Video proof on native: expo-video. The native player needs a file URI, so
 * the base64 payload from the media RPC is written to the app cache once per
 * path and played from there. Controls are the minimal native set.
 */
export function ProofVideo({
  serverId,
  proof,
}: {
  serverId: string;
  proof: MissionControlProof;
}): ReactElement | null {
  const path = proof.path ?? "";
  const media = useProofMedia({ serverId, path });
  if (!path) {
    return null;
  }

  if (media.status === "loading" || media.status === "idle") {
    return <Text style={styles.statusText}>Loading video…</Text>;
  }
  if (media.status === "error") {
    return <Text style={styles.errorText}>{media.error}</Text>;
  }
  return <VideoBody data={media.data} mimeType={media.mimeType} />;
}

function VideoBody({ data, mimeType }: { data: string; mimeType: string }): ReactElement {
  const cacheUri = useMemo(() => {
    const fileName = `proof-video-${data.slice(0, 16)}.${extensionForMimeType(mimeType)}`;
    return `${Paths.cache}${fileName}`;
  }, [data, mimeType]);

  const [isCached, setIsCached] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const file = new File(cacheUri);
    if (file.exists) {
      setIsCached(true);
      return;
    }
    try {
      file.write(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
    } catch (error) {
      if (!cancelled) {
        setCacheError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!cancelled) {
      setIsCached(true);
    }
    return () => {
      cancelled = true;
    };
  }, [cacheUri, data]);

  const player = useVideoPlayer(isCached ? { uri: cacheUri } : null, (instance) => {
    instance.loop = false;
  });

  useEffect(() => {
    return () => {
      player.release();
    };
  }, [player]);

  if (cacheError) {
    return <Text style={styles.errorText}>{cacheError}</Text>;
  }
  if (!isCached) {
    return <Text style={styles.statusText}>Loading video…</Text>;
  }
  return (
    <View style={styles.frame}>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls
        contentFit="contain"
        allowsFullscreen
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    height: 260,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  video: {
    width: "100%",
    height: "100%",
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
