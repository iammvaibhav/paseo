import React, { type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";

const CODE_EXCERPT_MAX_HEIGHT = 240;

/** api/code proofs → a mono code block from the inline excerpt. */
export function ProofCode({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const excerpt = proof.excerpt?.trim();
  if (!excerpt) {
    return null;
  }
  return (
    <View style={styles.surface}>
      <ScrollView style={styles.scroll} nestedScrollEnabled>
        <Text style={styles.code} selectable>
          {excerpt}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: {
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  scroll: {
    maxHeight: CODE_EXCERPT_MAX_HEIGHT,
  },
  code: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.foreground,
  },
}));
