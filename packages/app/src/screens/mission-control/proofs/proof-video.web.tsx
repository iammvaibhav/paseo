import React, { useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";
import { useProofMedia } from "./proof-media";

/** Base64 → Blob object URL; revoked when the component unmounts. */
function useVideoObjectUrl(data: string, mimeType: string): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [data, mimeType]);
  return objectUrl;
}

/**
 * Video proof on web: a native <video> element (per CLAUDE.md, DOM elements
 * live behind the isWeb/`<div>` exception and use the .web.tsx split). The
 * media RPC returns base64; the blob URL keeps the payload out of a data URI.
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
  const objectUrl = useVideoObjectUrl(data, mimeType);
  const videoStyle = useMemo(() => ({ width: "100%", height: "100%" }), []);
  if (!objectUrl) {
    return <Text style={styles.statusText}>Loading video…</Text>;
  }
  return (
    <View style={styles.frame}>
      <video
        controls
        preload="metadata"
        src={objectUrl}
        style={videoStyle}
        data-testid="mission-control-proof-video"
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
