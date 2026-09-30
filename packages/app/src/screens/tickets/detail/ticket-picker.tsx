import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { TicketSummary } from "@getpaseo/protocol/tickets/types";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { ICON_SIZE } from "@/styles/theme";

const ThemedPlus = withUnistyles(Plus);
const ADD_ICON = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const PICKER_MIN_WIDTH = 320;

interface TicketPickerProps {
  /** Trigger label, e.g. "Add". */
  label: string;
  /** Picker title, e.g. "Add a blocker". */
  title: string;
  candidates: readonly TicketSummary[];
  onPick: (ticket: TicketSummary) => void;
  pending?: boolean;
  testID?: string;
}

/**
 * A ghost "+ Add" button that opens a search over tickets by key or title.
 * The caller filters `candidates` (self, existing links, hierarchy rules).
 */
export function TicketPicker({
  label,
  title,
  candidates,
  onPick,
  pending = false,
  testID,
}: TicketPickerProps): ReactElement {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const byId = useMemo(
    () => new Map(candidates.map((ticket) => [ticket.id, ticket])),
    [candidates],
  );
  const options = useMemo<ComboboxOption[]>(
    () =>
      candidates.map((ticket) => ({
        id: ticket.id,
        label: `${ticket.key}  ${ticket.title}`,
      })),
    [candidates],
  );
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleSelect = useCallback(
    (id: string) => {
      const ticket = byId.get(id);
      setOpen(false);
      if (ticket) {
        onPick(ticket);
      }
    },
    [byId, onPick],
  );

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={ADD_ICON}
          loading={pending}
          onPress={handleOpen}
          testID={testID}
        >
          {label}
        </Button>
      </View>
      <Combobox
        options={options}
        value=""
        onSelect={handleSelect}
        searchable
        searchPlaceholder={t("tickets.detail.picker.searchPlaceholder")}
        emptyText={t("tickets.detail.picker.empty")}
        title={title}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopMinWidth={PICKER_MIN_WIDTH}
      />
    </>
  );
}
