import React, { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MissionControlProof } from "@getpaseo/protocol/mission-control/types";
import { ProofCode } from "./proof-code";
import { ProofImage } from "./proof-image";
import { ProofSection } from "./proof-section";
import { ProofUrlChip } from "./proof-url";
import { ProofVideo } from "./proof-video";

// ============================================================================
// Proof sections on feed cards + thread cards. Spec kinds (image/video/api/
// code/pr/url) render as collapsed-by-default sections with kind headers;
// legacy diff/command proofs keep their chips. Collapsed-by-default is
// reserved for proofs per the card-consistency rule.
// ============================================================================

export type SpecProofKind = "image" | "video" | "api" | "code" | "pr" | "url";

const PROOF_KIND_HEADERS: Record<SpecProofKind, string> = {
  image: "Image proof",
  video: "Video proof",
  api: "API proof",
  code: "Code proof",
  pr: "PR",
  url: "URL",
};

export function isSpecProofKind(kind: MissionControlProof["kind"]): kind is SpecProofKind {
  return (
    kind === "image" ||
    kind === "video" ||
    kind === "api" ||
    kind === "code" ||
    kind === "pr" ||
    kind === "url"
  );
}

function proofChipLabel(proof: MissionControlProof): string {
  return (proof.label || proof.url || proof.path || "").trim();
}

/** Legacy diff proof chip (old persisted events). */
function LegacyDiffChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const additions = proof.additions ?? 0;
  const deletions = proof.deletions ?? 0;
  return (
    <View style={styles.chip}>
      <Text style={styles.chipDiffAdd}>+{additions}</Text>
      <Text style={styles.chipDiffDel}>−{deletions}</Text>
    </View>
  );
}

/** Legacy command proof chip (old persisted events). */
function LegacyCommandChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const label = proofChipLabel(proof);
  if (!label) {
    return null;
  }
  return (
    <View style={styles.chip}>
      <Text style={styles.chipCommandText} numberOfLines={1}>
        {label}
        {proof.exitCode !== undefined ? ` · exit ${proof.exitCode}` : ""}
      </Text>
    </View>
  );
}

function LegacyProofChip({ proof }: { proof: MissionControlProof }): ReactElement | null {
  switch (proof.kind) {
    case "diff":
      return <LegacyDiffChip proof={proof} />;
    case "command":
      return <LegacyCommandChip proof={proof} />;
    default:
      return null;
  }
}

function ProofBody({
  kind,
  proof,
  serverId,
}: {
  kind: SpecProofKind;
  proof: MissionControlProof;
  serverId: string;
}): ReactElement | null {
  switch (kind) {
    case "image":
      return <ProofImage serverId={serverId} proof={proof} />;
    case "video":
      return <ProofVideo serverId={serverId} proof={proof} />;
    case "api":
    case "code":
      return <ProofCode proof={proof} />;
    case "pr":
    case "url":
      return <ProofUrlChip proof={proof} />;
  }
}

function ProofLabel({ proof }: { proof: MissionControlProof }): ReactElement | null {
  const label = proof.label?.trim();
  if (!label) {
    return null;
  }
  return <Text style={styles.proofLabel}>{label}</Text>;
}

interface ProofSectionsProps {
  proofs: MissionControlProof[];
  serverId: string;
}

export function ProofSections({ proofs, serverId }: ProofSectionsProps): ReactElement | null {
  const sections = useMemo(() => {
    const byKind = new Map<SpecProofKind, MissionControlProof[]>();
    for (const proof of proofs) {
      if (!isSpecProofKind(proof.kind)) {
        continue;
      }
      const list = byKind.get(proof.kind) ?? [];
      list.push(proof);
      byKind.set(proof.kind, list);
    }
    return [...byKind.entries()].map(([kind, items]) => ({ kind, items }));
  }, [proofs]);

  const legacyProofs = useMemo(
    () => proofs.filter((proof) => !isSpecProofKind(proof.kind)),
    [proofs],
  );

  if (sections.length === 0 && legacyProofs.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      {sections.map(({ kind, items }) => (
        <ProofSection
          key={kind}
          header={PROOF_KIND_HEADERS[kind]}
          body={items.map((proof) => (
            <View
              key={`${proof.kind}:${proof.url ?? proof.path ?? proof.label ?? proof.excerpt ?? ""}`}
              style={styles.proofItem}
            >
              <ProofLabel proof={proof} />
              <ProofBody kind={kind} proof={proof} serverId={serverId} />
            </View>
          ))}
        />
      ))}
      {legacyProofs.length > 0 ? (
        <View style={styles.chipRow}>
          {legacyProofs.map((proof) => (
            <LegacyProofChip
              key={`${proof.kind}:${proof.url ?? proof.path ?? proof.label ?? ""}`}
              proof={proof}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginTop: theme.spacing[2],
  },
  proofItem: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[2],
  },
  proofLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  chip: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  chipDiffAdd: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.success,
  },
  chipDiffDel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  chipCommandText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
