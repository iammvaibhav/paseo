// Kept free of React and runtime imports: the push router (loaded by the host
// runtime) writes usage pushes into this key without an import cycle back into
// the runtime.
export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}
