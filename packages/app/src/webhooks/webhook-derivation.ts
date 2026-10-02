import type { WebhookSummary } from "@getpaseo/protocol/webhook/types";
import { describeScheduleCwd } from "@/schedules/schedule-project-targets";

export interface WebhookTargetAgent {
  title: string | null;
  provider: string | null;
}

export interface WebhookTargetResolution {
  /** The target line: agent title, project name, or the shortened cwd. */
  label: string;
  /** Provider glyph for the row, when known. */
  provider: string | null;
}

export interface ResolveWebhookTargetInput {
  webhook: WebhookSummary;
  serverId: string;
  /** Client agent directory keyed by `${serverId}:${agentId}`. */
  agentsByKey: ReadonlyMap<string, WebhookTargetAgent>;
  /** Known project roots keyed by `${serverId}:${cwd}`. */
  projectNameByCwd: ReadonlyMap<string, string>;
}

function agentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function resolveWebhookTarget(input: ResolveWebhookTargetInput): WebhookTargetResolution {
  const { webhook, serverId, agentsByKey, projectNameByCwd } = input;
  if (webhook.target.type === "agent") {
    const agent = agentsByKey.get(agentKey(serverId, webhook.target.agentId));
    if (agent) {
      return { label: agent.title?.trim() || "Untitled agent", provider: agent.provider };
    }
    return { label: "Agent unavailable", provider: null };
  }
  return {
    label: describeScheduleCwd({ serverId, cwd: webhook.target.config.cwd, projectNameByCwd }),
    provider: webhook.target.config.provider,
  };
}

export function resolveWebhookTitle(webhook: WebhookSummary): string {
  return webhook.name?.trim() || "Untitled webhook";
}

/** Build the public hook URL, or null when the host has no tunnel configured. */
export function buildHookUrl(
  publicBaseUrl: string | null,
  webhook: {
    id: string;
    secret: string;
  },
): string | null {
  const base = publicBaseUrl?.trim();
  if (!base) {
    return null;
  }
  const normalized = base.replace(/\/+$/, "");
  return `${normalized}/hooks/${webhook.id}/${webhook.secret}`;
}
