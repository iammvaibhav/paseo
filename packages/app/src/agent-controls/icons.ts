import type { ComponentType } from "react";
import {
  Bot,
  Brain,
  Bug,
  Eye,
  Hammer,
  ListChecks,
  ListTodo,
  Network,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
  Zap,
} from "lucide-react-native";
import { DEFAULT_AGENT_MODE_ID, type AgentModeId } from "@getpaseo/protocol/agent-modes";
import { getModeVisuals, type AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

export interface AgentControlIconProps {
  size: number;
  color: string;
}

export type AgentControlIcon = ComponentType<AgentControlIconProps>;

export const ThinkingIcon = Brain;
export const PlanModeIcon = ListTodo;

const MODE_ICONS: Record<string, AgentControlIcon> = {
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
};

const FEATURE_ICONS: Record<string, AgentControlIcon> = {
  "list-todo": ListTodo,
  "shield-check": ShieldCheck,
  zap: Zap,
};

export function getAgentModeIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon {
  if (modeId === "ai-review") return ShieldCheck;
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return (icon ? MODE_ICONS[icon] : undefined) ?? Bot;
}

export function getAgentModeOptionIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon | undefined {
  if (modeId === "ai-review") return ShieldCheck;
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return icon ? MODE_ICONS[icon] : undefined;
}

export function getAgentFeatureIcon(icon?: string): AgentControlIcon {
  return (icon ? FEATURE_ICONS[icon] : undefined) ?? Settings2;
}

const APPROACH_ICONS: Record<AgentModeId, AgentControlIcon> = {
  solo: Hammer,
  orchestrator: Network,
  plan: ListChecks,
  research: Search,
  review: Eye,
  debug: Bug,
};

/** Icon for an approach (agent mode); an unknown id from a newer host gets the default's icon. */
export function getApproachIcon(id: string): AgentControlIcon {
  return APPROACH_ICONS[id as AgentModeId] ?? APPROACH_ICONS[DEFAULT_AGENT_MODE_ID];
}
