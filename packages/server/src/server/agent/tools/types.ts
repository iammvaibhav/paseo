import type { z } from "zod";

export interface PaseoToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: PaseoToolResult) => void;
  /**
   * Session-scoped tools (fleet_monitor) key their subscriptions on this.
   * The session RPC front passes the daemon session id; agent callers fall
   * back to their callerAgentId. Absent → the tool degrades gracefully.
   */
  sessionKey?: string;
}

export interface PaseoToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PaseoToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface PaseoToolDefinition extends PaseoToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

export interface PaseoToolCatalog {
  tools: ReadonlyMap<string, PaseoToolDefinition>;
  getTool(name: string): PaseoToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: PaseoToolExecutionContext,
  ): Promise<PaseoToolResult>;
}

export interface PaseoToolRuntimeContext {
  callerAgentId?: string;
  /**
   * Labels of the caller when known at catalog-build time. Launch contexts
   * are built BEFORE the agent registers, so label-gated tools (verifier)
   * must read these instead of racing the registry lookup.
   */
  callerLabels?: Readonly<Record<string, string>>;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type PaseoToolCatalogFactory = (
  context: PaseoToolRuntimeContext,
) => PaseoToolCatalog | Promise<PaseoToolCatalog>;
