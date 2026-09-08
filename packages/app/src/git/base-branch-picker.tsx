import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { GitBranch, Undo2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Combobox,
  ComboboxItem,
  type ComboboxOption,
  type ComboboxProps,
} from "@/components/ui/combobox";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarLabelSelectTrigger } from "@/components/ui/toolbar-label-trigger";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useComparisonBaseBranches } from "@/git/use-comparison-base-branches";

export interface ChangesBaseBranchPickerProps {
  serverId: string;
  cwd: string;
  /** Display name of the base the diff is computed against right now. */
  label: string;
  baseRef?: string;
  defaultBaseRef?: string;
  isCustomBaseRef: boolean;
  onSelectBaseRef: (baseRef: string | null) => void;
}

// "@{" is illegal in a git ref name, so this id can never shadow a real branch.
const DEFAULT_OPTION_ID = "@{default}";

const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedUndo2 = withUnistyles(Undo2);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

export function ChangesBaseBranchPicker({
  serverId,
  cwd,
  label,
  baseRef,
  defaultBaseRef,
  isCustomBaseRef,
  onSelectBaseRef,
}: ChangesBaseBranchPickerProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const { branches, isLoading, errorMessage } = useComparisonBaseBranches({
    serverId,
    cwd,
    enabled: isOpen,
  });

  const options = useMemo<ComboboxOption[]>(() => {
    const defaultHint = t("workspace.git.diff.baseBranchDefaultHint");
    const rows: ComboboxOption[] = [
      {
        id: DEFAULT_OPTION_ID,
        label: t("workspace.git.diff.baseBranchDefault", {
          name: defaultBaseRef ?? t("workspace.git.diff.base"),
        }),
      },
    ];
    // A pick that the suggestion list does not carry (or has not loaded yet) still needs a
    // row, or the check would point at nothing.
    if (isCustomBaseRef && baseRef && !branches.includes(baseRef)) {
      rows.push({ id: baseRef, label: baseRef });
    }
    for (const name of branches) {
      rows.push(
        name === defaultBaseRef
          ? { id: name, label: name, description: defaultHint }
          : { id: name, label: name },
      );
    }
    return rows;
  }, [baseRef, branches, defaultBaseRef, isCustomBaseRef, t]);

  const value = isCustomBaseRef && baseRef ? baseRef : DEFAULT_OPTION_ID;

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleSelect = useCallback(
    (id: string) => onSelectBaseRef(id === DEFAULT_OPTION_ID ? null : id),
    [onSelectBaseRef],
  );

  const renderOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => {
      const isDefaultRow = option.id === DEFAULT_OPTION_ID;
      return (
        <ComboboxItem
          testID={
            isDefaultRow ? "changes-base-branch-default" : `changes-base-branch-option-${option.id}`
          }
          label={option.label}
          description={option.description}
          selected={selected}
          active={active}
          onPress={onPress}
          leadingSlot={
            isDefaultRow ? (
              <ThemedUndo2 size={14} uniProps={mutedIconColorMapping} />
            ) : (
              <ThemedGitBranch size={14} uniProps={mutedIconColorMapping} />
            )
          }
        />
      );
    },
    [],
  );

  let footer: ReactNode = null;
  if (isLoading) {
    footer = (
      <View style={styles.footerRow}>
        <ThemedLoadingSpinner size={14} uniProps={mutedIconColorMapping} />
        <Text style={styles.footerText}>{t("workspace.git.diff.baseBranchLoading")}</Text>
      </View>
    );
  } else if (errorMessage) {
    footer = (
      <View style={styles.footerRow}>
        <Text style={styles.footerErrorText} numberOfLines={2}>
          {errorMessage}
        </Text>
      </View>
    );
  }

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <ToolbarLabelSelectTrigger
            testID="changes-base-branch-trigger"
            label={label}
            open={isOpen}
            onPress={handleOpen}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.git.diff.baseBranchTrigger", { name: label })}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{t("workspace.git.diff.baseBranchTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        searchable
        searchPlaceholder={t("workspace.git.diff.baseBranchSearchPlaceholder")}
        emptyText={t("workspace.git.diff.baseBranchEmpty")}
        title={t("workspace.git.diff.baseBranch")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={renderOption}
        footer={footer}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    flexShrink: 1,
    minWidth: 0,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  footerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  footerErrorText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
}));
