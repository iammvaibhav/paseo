import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageUpdatedMessage,
  ProviderUsageWindow,
} from "@getpaseo/protocol/messages";

export type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
};

export type ProviderUsageBalanceUnit = ProviderUsageBalance["unit"];

// What the usage surfaces render. The RPC response carries a `requestId` on top of
// this, but that is transport correlation — daemon pushes arrive without one, and both
// sources land in the same cache entry.
export type ProviderUsageSnapshot = ProviderUsageUpdatedMessage["payload"];

export type ProviderUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: ProviderUsageSnapshot; isRefreshing: boolean };
