import type { RedactedPaseoAgentProviderConfig } from "@getpaseo/protocol/messages";
import type { PaseoAgentSetProviderInput } from "@/hooks/use-paseo-agent-providers";

export function paseoAgentAuthLabel(auth: RedactedPaseoAgentProviderConfig["auth"]): string {
  if (auth.kind === "oauth") {
    return auth.configured ? "ChatGPT login stored" : "Login required";
  }
  if (auth.kind === "none") {
    return "No auth";
  }
  return auth.configured ? "API key configured" : "API key required";
}

export function parsePaseoAgentModelIds(raw: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const id = part.trim();
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function createOpenRouterProviderInput(input: {
  name: string;
  apiKey: string;
  modelIds: string[];
}): PaseoAgentSetProviderInput {
  const trimmedKey = input.apiKey.trim();
  return {
    name: input.name.trim(),
    providerType: "openrouter",
    options: {
      models: input.modelIds.map((id) => ({ id })),
      ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
    },
  };
}
