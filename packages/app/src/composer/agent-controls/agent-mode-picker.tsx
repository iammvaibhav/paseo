import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AGENT_MODES, DEFAULT_AGENT_MODE_ID } from "@getpaseo/protocol/agent-modes";
import { Combobox } from "@/components/ui/combobox";
import type { ComboboxOption } from "@/components/ui/combobox";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

const AGENT_MODE_OPTIONS: ComboboxOption[] = AGENT_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  description: mode.description,
}));

/**
 * Agent mode for a running agent (Do it yourself, Orchestrator, …). Changing
 * it sends nothing: the mode's instructions ride the user's next message, so
 * work only starts when the user writes and the provider's cached system
 * prompt stays intact.
 */
export function LiveAgentModePicker({
  serverId,
  agentId,
  disabled,
}: {
  serverId: string;
  agentId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const supported = useHostFeature(serverId, "agentModes");
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const agentMode = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.agentMode ?? null,
  );
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  const current = agentMode ?? DEFAULT_AGENT_MODE_ID;
  const label = useMemo(
    () => AGENT_MODE_OPTIONS.find((option) => option.id === current)?.label ?? current,
    [current],
  );
  const handleSelect = useCallback(
    (id: string) => {
      setOpen(false);
      if (!client || id === current) return;
      client.setAgentAgentMode(agentId, id).catch((error: unknown) => {
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, client, current, toast],
  );
  const handleOpen = useCallback(() => setOpen(true), []);

  if (!supported || agentMode === null) return null;
  return (
    <View>
      <Pressable
        ref={anchorRef}
        accessibilityRole="button"
        accessibilityLabel={t("agentMode.label")}
        onPress={handleOpen}
        disabled={disabled || !client}
        style={styles.trigger}
        testID="agent-controls-agent-mode"
      >
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      <Combobox
        options={AGENT_MODE_OPTIONS}
        value={current}
        onSelect={handleSelect}
        title={t("agentMode.label")}
        open={open}
        onOpenChange={setOpen}
        desktopPlacement="top-start"
        desktopMinWidth={320}
        anchorRef={anchorRef}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
