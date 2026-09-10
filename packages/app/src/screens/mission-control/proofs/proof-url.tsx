import React, { type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";
import { ExternalLink } from "@/components/ui/external-link";

function proofChipLabel(proof: MissionControlProof): string {
  return (proof.label || proof.url || proof.path || "").trim();
}

/** pr/url proofs → a chip link (external URL when present, else a plain chip). */
export function ProofUrlChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const label = proofChipLabel(proof);
  if (!label) {
    return null;
  }
  if (proof.url) {
    return <ExternalLink href={proof.url} label={label} />;
  }
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  chipText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
