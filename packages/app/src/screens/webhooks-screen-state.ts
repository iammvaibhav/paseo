import type { AggregateLoadState, AggregatedWebhook } from "@/webhooks/aggregated-webhooks";

export type WebhooksScreenBodyState =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

export function resolveWebhooksScreenBodyState(input: {
  loadState: AggregateLoadState<AggregatedWebhook>;
  showLoadError: boolean;
}): WebhooksScreenBodyState {
  if (input.showLoadError) {
    return { kind: "load-error" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  if (input.loadState.data.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}
