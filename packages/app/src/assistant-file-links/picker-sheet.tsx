import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MaterialFileIcon } from "@/components/material-file-icon";
import type { InlinePathTarget } from "./parse";
import { formatFileLinkTooltipPath } from "./tooltip-path";

export interface FileLinkPickerRequest {
  token: string;
  candidates: InlinePathTarget[];
  onSelect: (target: InlinePathTarget) => void;
}

interface FileLinkPickerSheetProps {
  request: FileLinkPickerRequest;
  workspaceRoot?: string;
  onClose: () => void;
}

/** Lets the user say which workspace file a reference meant when several match it. */
export function FileLinkPickerSheet({ request, workspaceRoot, onClose }: FileLinkPickerSheetProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("fileLinkPicker.title", { token: request.token }),
      subtitle: (
        <Text style={styles.subtitle} numberOfLines={1}>
          {t("fileLinkPicker.subtitle", { count: request.candidates.length })}
        </Text>
      ),
    }),
    [request.candidates.length, request.token, t],
  );
  const handleSelect = useCallback(
    (target: InlinePathTarget) => {
      onClose();
      request.onSelect(target);
    },
    [onClose, request],
  );

  return (
    <AdaptiveModalSheet visible header={header} onClose={onClose} testID="file-link-picker">
      <View style={styles.list}>
        {request.candidates.map((candidate) => (
          <FileLinkPickerRow
            key={candidate.path}
            candidate={candidate}
            label={formatFileLinkTooltipPath({ target: candidate, workspaceRoot })}
            onSelect={handleSelect}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

function FileLinkPickerRow({
  candidate,
  label,
  onSelect,
}: {
  candidate: InlinePathTarget;
  label: string;
  onSelect: (target: InlinePathTarget) => void;
}) {
  const handlePress = useCallback(() => onSelect(candidate), [candidate, onSelect]);
  const fileName = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={rowStyle}
      testID="file-link-picker-row"
    >
      <MaterialFileIcon fileName={fileName} size={16} />
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function rowStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, (hovered || pressed) && styles.rowActive];
}

const styles = StyleSheet.create((theme) => ({
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  list: {
    paddingBottom: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowActive: { backgroundColor: theme.colors.surface1 },
  label: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
