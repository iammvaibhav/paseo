import type { AggregatedAutomation, AutomationAggregateLoadState } from "@/hooks/use-automations";

export type AutomationsScreenBodyState =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "content"; rows: AggregatedAutomation[] };

export function resolveAutomationsScreenBodyState(input: {
  loadState: AutomationAggregateLoadState;
  isError: boolean;
}): AutomationsScreenBodyState {
  if (input.isError && input.loadState.status !== "loaded") {
    return { kind: "load-error" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  return { kind: "content", rows: input.loadState.data };
}
