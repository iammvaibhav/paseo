import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useHostFeature } from "@/runtime/host-features";

export type StartOption = "task" | "orchestrator";

export function StartOptionToggle({
  serverId,
  value,
  onValueChange,
  disabled = false,
  size = "sm",
}: {
  serverId: string;
  value: StartOption;
  onValueChange: (value: StartOption) => void;
  disabled?: boolean;
  size?: "xs" | "sm" | "md";
}): ReactElement | null {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "orchestrator");
  const options: SegmentedControlOption<StartOption>[] = [
    { value: "task", label: t("startOption.doTask"), testID: "start-option-task" },
    {
      value: "orchestrator",
      label: t("startOption.orchestrator"),
      testID: "start-option-orchestrator",
    },
  ];
  const handleChange = useCallback(
    (next: StartOption) => {
      if (!disabled) onValueChange(next);
    },
    [disabled, onValueChange],
  );

  if (!supported) return null;
  return (
    <View style={styles.container} testID="start-option-toggle">
      <SegmentedControl options={options} value={value} onValueChange={handleChange} size={size} />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  container: {
    alignSelf: "center",
  },
}));
