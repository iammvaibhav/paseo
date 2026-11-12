/**
 * Paseo spells a provider+model pair two ways. Config and the app key models
 * as "provider:model" (daemon.visibleModels, routing.modelByMode); every spawn
 * surface (MCP tools, CLI, schedules) takes "provider/model", split on the
 * first "/". This returns the spawn form.
 *
 * Provider ids never contain ":" or "/" (see PROVIDER_ID_PATTERN in
 * provider-config.ts), so a ":" before the first "/" can only be the provider
 * separator. A ":" after the first "/" belongs to the model id and is kept.
 */
export function canonicalProviderModel(value: string): string {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  const slash = trimmed.indexOf("/");
  if (colon > 0 && (slash === -1 || colon < slash)) {
    return `${trimmed.slice(0, colon)}/${trimmed.slice(colon + 1)}`;
  }
  return trimmed;
}
