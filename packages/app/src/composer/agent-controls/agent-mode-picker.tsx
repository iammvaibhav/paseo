import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE_ID,
  getAgentModeDefinition,
} from "@getpaseo/protocol/agent-modes";
import { type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getApproachIcon } from "@/agent-controls/icons";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

const APPROACH_OPTIONS: ComboboxOption[] = AGENT_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  description: mode.description,
}));

// Row icons take the foreground color like the access mode rows; withUnistyles
// keeps them theme-reactive without re-rendering the picker.
const THEMED_APPROACH_ICONS = Object.fromEntries(
  AGENT_MODES.map((mode) => [mode.id, withUnistyles(getApproachIcon(mode.id))]),
);
const foregroundIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * One approach row: icon and label like the access mode rows. The one-line
 * description shows in a tooltip instead of being truncated inline.
 */
function ApproachOption({
  option,
  selected,
  active,
  onPress,
}: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}): ReactElement {
  const Icon = THEMED_APPROACH_ICONS[option.id];
  const leadingSlot = useMemo(
    () => (Icon ? <Icon size={16} uniProps={foregroundIconColorMapping} /> : null),
    [Icon],
  );
  return (
    <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger>
        <ComboboxItem
          label={option.label}
          selected={selected}
          active={active}
          onPress={onPress}
          leadingSlot={leadingSlot}
          testID={`agent-mode-option-${option.id}`}
        />
      </TooltipTrigger>
      <TooltipContent side="right" align="center" offset={8}>
        <Text style={styles.tooltipText}>{option.description}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function renderApproachOption(args: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <ApproachOption
      option={args.option}
      selected={args.selected}
      active={args.active}
      onPress={args.onPress}
    />
  );
}

/**
 * Approach for a running agent (Build, Orchestrate, …). Changing it sends
 * nothing: the approach's instructions ride the user's next message, so work
 * only starts when the user writes and the provider's cached system prompt
 * stays intact. Built like the access mode control so the toolbar reads as one
 * row of the same chips.
 */
export function LiveAgentModePicker({
  serverId,
  agentId,
  disabled,
  surface = "toolbar",
}: {
  serverId: string;
  agentId: string;
  disabled?: boolean;
  surface?: "toolbar" | "sheet";
}) {
  const { t } = useTranslation();
  const { presentation } = useComposerControlLayout();
  const toast = useToast();
  const supported = useHostFeature(serverId, "agentModes");
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const agentMode = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.agentMode ?? null,
  );
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const anchorRef = useRef<View>(null);
  const current = agentMode ?? DEFAULT_AGENT_MODE_ID;
  const label = getAgentModeDefinition(current)?.label ?? current;

  const options = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return APPROACH_OPTIONS;
    return APPROACH_OPTIONS.filter((option) => option.label.toLowerCase().includes(query));
  }, [searchQuery]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setSearchQuery("");
  }, []);
  const handlePress = useCallback(() => handleOpenChange(!open), [handleOpenChange, open]);
  const handleSelect = useCallback(
    (id: string) => {
      handleOpenChange(false);
      if (!client || id === current) return;
      client.setAgentAgentMode(agentId, id).catch((error: unknown) => {
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, client, current, handleOpenChange, toast],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: t("agentMode.label"),
      search: {
        onChange: setSearchQuery,
        placeholder: t("agentMode.searchPlaceholder"),
        testID: "agent-mode-search-input",
      },
    }),
    [t],
  );

  if (!supported || agentMode === null) return null;
  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={getApproachIcon(current)}
            surface={surface}
            label={t("agentMode.label")}
            value={label}
            showToolbarLabel={presentation.showModeLabel}
            showCaret={surface === "toolbar" && presentation.showCarets}
            open={open}
            disabled={disabled || !client}
            onPress={handlePress}
            accessibilityLabel={t("agentMode.selectWithValue", { value: label })}
            testID="agent-controls-agent-mode"
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("agentMode.tooltip")}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={options}
        value={current}
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={260}
        header={sheetHeader}
        renderOption={renderApproachOption}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
