import type { AgentToolCallData } from "@/types/stream";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readDispatchResultString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

/**
 * A dispatch tool can fail without a "failed" tool status: some paseo tools
 * reject with a structured result (`{ success: false, error }` / `{ ok: false,
 * message }`) instead of throwing, and some runtimes drop the tool-execution
 * isError flag. Detect the failure from the result so the thread never renders
 * a success-shaped header for a rejection. Returns the error text or null.
 */
export function readDispatchToolResultError(data: AgentToolCallData): string | null {
  const detail = data.detail;
  if (detail.type !== "unknown" || !isPlainRecord(detail.output)) {
    return null;
  }
  const details = isPlainRecord(detail.output.details) ? detail.output.details : detail.output;
  const success = details.success ?? details.ok;
  if (success === false) {
    return (
      readDispatchResultString(details.error) ??
      readDispatchResultString(details.message) ??
      readDispatchResultString(details.reason) ??
      "Dispatch failed"
    );
  }
  return null;
}
