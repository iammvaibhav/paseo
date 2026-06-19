import { execSync } from "node:child_process";
import { hasEnvReference, substituteEnvReferences } from "./env-references.js";

// Resolution of a *self-supplied* OAuth refresh token expression — a literal, an env
// reference (`$VAR` / `${VAR}`), or a `!command` that prints the token. This is an
// advanced/manual escape hatch for users who already hold their own ChatGPT/Codex
// refresh token; the product path is `paseo login chatgpt`, which performs browser
// OAuth by default and writes a Paseo-owned credential store (see oauth-store.ts).
//
// This module deliberately does NOT read any other tool's auth files (Codex CLI,
// OpenCode, Pi, etc.) and imports no Pi runtime code. Token values are never logged.

/**
 * Resolve a refresh-token expression to its literal value (may run a `!command`).
 * Returns undefined when it can't be resolved.
 */
export function resolveRefreshTokenExpression(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (value.startsWith("!")) {
    const command = value.slice(1).trim();
    if (!command) {
      return undefined;
    }
    try {
      const output = execSync(command, { encoding: "utf8", env }).trim();
      return output.length > 0 ? output : undefined;
    } catch {
      return undefined;
    }
  }
  if (hasEnvReference(value)) {
    const substituted = substituteEnvReferences(value, env);
    return substituted && substituted.length > 0 ? substituted : undefined;
  }
  return value.length > 0 ? value : undefined;
}

/**
 * Cheap check: could this refresh-token expression yield a value without running a
 * command? `!command` is assumed runnable; env refs require their vars to be set.
 */
export function isRefreshTokenExpressionConfigured(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (value.startsWith("!")) {
    return true;
  }
  if (hasEnvReference(value)) {
    return substituteEnvReferences(value, env) !== undefined;
  }
  return value.length > 0;
}
