import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";

export interface TicketAction<TInput> {
  pending: boolean;
  /** Resolves true on success. A failure shows a toast and resolves false. */
  run: (input: TInput) => Promise<boolean>;
}

/**
 * Pending and failure UI for one ticket mutation. The board host sends the
 * result through `tickets.changed`, so success needs no extra feedback.
 */
export function useTicketAction<TInput, TResult>(
  action: (input: TInput) => Promise<TResult>,
  failureLabel: string,
): TicketAction<TInput> {
  const { t } = useTranslation();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (input: TInput) => {
      setPending(true);
      try {
        await action(input);
        return true;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        toast.error(
          t("tickets.detail.errors.withReason", { action: failureLabel, message: error.message }),
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [action, failureLabel, t, toast],
  );

  return { pending, run };
}
