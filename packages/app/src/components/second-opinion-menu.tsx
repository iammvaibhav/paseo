import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Bot } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

export interface SecondOpinionMenuProps {
  serverId: string;
  currentProvider?: string;
  currentModel?: string | null;
  cwd?: string | null;
  onSecondOpinion: (target: { provider: string; model: string }) => Promise<void> | void;
  disabled?: boolean;
  testID?: string;
}

const ThemedBot = withUnistyles(Bot);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SecondOpinionModelRowsProps {
  providerId: string;
  rows: ProviderSelectionModelRow[];
  pendingModel?: string | null;
  isLocked?: boolean;
  onSelect?: (provider: string, model: string) => () => Promise<void>;
  testID?: string;
}

function SecondOpinionModelRows({
  providerId,
  rows,
  pendingModel = null,
  isLocked = false,
  onSelect,
  testID = "second-opinion-menu",
}: SecondOpinionModelRowsProps) {
  return (
    <>
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.favoriteKey}
          closeOnSelect={false}
          disabled={isLocked}
          status={pendingModel === `${providerId}:${row.modelId}` ? "pending" : undefined}
          onSelect={onSelect?.(providerId, row.modelId)}
          testID={`${testID}-model-${providerId}-${row.modelId}`}
        >
          {row.modelLabel || row.modelId}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function removeCurrentModel(
  provider: ProviderSelectorProvider,
  currentProvider: string | undefined,
  currentModel: string | null | undefined,
): ProviderSelectionModelRow[] {
  if (provider.modelSelection.kind !== "models") {
    return [];
  }
  const rows = provider.modelSelection.rows;
  if (provider.id !== currentProvider || !currentModel) {
    return rows;
  }
  const current = currentModel.trim();
  return rows.filter((row) => row.modelId.trim() !== current);
}

export const SecondOpinionMenu = memo(function SecondOpinionMenu({
  serverId,
  currentProvider,
  currentModel,
  cwd,
  onSecondOpinion,
  disabled = false,
  testID = "second-opinion-menu",
}: SecondOpinionMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const isLocked = pendingModel !== null;

  const { entries, isLoading } = useProvidersSnapshot(serverId, {
    cwd: cwd ?? null,
  });

  const filteredProviders = useMemo(() => {
    const options: Array<{ id: string; label: string; rows: ProviderSelectionModelRow[] }> = [];
    const providers: ProviderSelectorProvider[] = buildSelectableProviderSelectorProviders(entries);
    for (const p of providers) {
      if (p.modelSelection.kind !== "models") {
        continue;
      }
      const rows = removeCurrentModel(p, currentProvider, currentModel);
      if (rows.length > 0) {
        options.push({ id: p.id, label: p.label, rows });
      }
    }
    return options;
  }, [entries, currentProvider, currentModel]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (isLocked) return;
      setIsOpen(next);
    },
    [isLocked],
  );

  const handleSelect = useCallback(
    (provider: string, model: string) => async () => {
      if (isLocked) return;
      const key = `${provider}:${model}`;
      setPendingModel(key);
      try {
        await onSecondOpinion({ provider, model });
        setIsOpen(false);
      } finally {
        setPendingModel(null);
      }
    },
    [isLocked, onSecondOpinion],
  );

  const triggerStyle = useCallback(
    () => [styles.trigger, isLocked || disabled ? styles.triggerDisabled : null],
    [disabled, isLocked],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>
          {t("message.actions.secondOpinion", "Second opinion")}
        </Text>
      </TooltipContent>
    ),
    [t],
  );

  const pages = useMemo<MenuPageDefinition[]>(
    () =>
      filteredProviders.map((p) => ({
        id: p.id,
        title: p.label,
        content: (
          <SecondOpinionModelRows
            providerId={p.id}
            rows={p.rows}
            pendingModel={pendingModel}
            isLocked={isLocked}
            onSelect={handleSelect}
            testID={testID}
          />
        ),
      })),
    [filteredProviders, handleSelect, isLocked, pendingModel, testID],
  );

  const renderContent = () => {
    if (isLoading && filteredProviders.length === 0) {
      return <DropdownMenuItem disabled>{t("common.loading", "Loading...")}</DropdownMenuItem>;
    }
    if (filteredProviders.length === 0) {
      return (
        <DropdownMenuItem disabled>
          {t("message.actions.noOtherModels", "No other models available")}
        </DropdownMenuItem>
      );
    }
    if (filteredProviders.length === 1) {
      const single = filteredProviders[0];
      if (!single) {
        return null;
      }
      return (
        <SecondOpinionModelRows
          providerId={single.id}
          rows={single.rows}
          pendingModel={pendingModel}
          isLocked={isLocked}
          onSelect={handleSelect}
          testID={testID}
        />
      );
    }
    return (
      <>
        {filteredProviders.map((p) => (
          <DropdownMenuSubTrigger key={p.id} id={p.id} testID={`${testID}-provider-${p.id}`}>
            {p.label}
          </DropdownMenuSubTrigger>
        ))}
      </>
    );
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={t("message.actions.secondOpinion", "Second opinion")}
              accessibilityRole="button"
              disabled={isLocked || disabled}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <ThemedBot
                  size={ICON_SIZE.sm}
                  uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent
        align="start"
        minWidth={220}
        side="bottom"
        pages={pages}
        testID={`${testID}-content`}
      >
        {renderContent()}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
