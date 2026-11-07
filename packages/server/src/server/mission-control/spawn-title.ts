import { NAME_POOLS } from "./naming.js";

/**
 * Agent identity has exactly one author: the daemon's AgentNamingService,
 * which assigns the themed chip name once at creation.
 *
 * The Commander used to write a name of its own into the spawn TITLE. It was
 * told to "name agents consistently with the fleet's naming theme" and shown
 * every roster entry as `name — title`, so it copied that shape into the one
 * field it controls. The result was one agent wearing two names: chip
 * "Erwin", title "Dirac — paseo dev test agent".
 *
 * The prompt no longer asks it to name anything. This strip is the
 * deterministic half: a model that ignores the prompt still cannot mint a
 * second identity.
 */
const POOL_NAMES: ReadonlySet<string> = new Set(Object.values(NAME_POOLS).flat());

/** `<PoolName> — rest` / `<PoolName> - rest`, requiring a non-empty rest. */
const NAME_PREFIX_PATTERN = /^\s*([A-Za-z]+)\s*[—–-]\s+(\S.*)$/;

/**
 * Removes a leading themed-name prefix from a spawn title. Only a name from
 * the naming pools followed by a dash separator is treated as an identity
 * prefix, so ordinary titles ("Deploy — restart the fleet") are untouched.
 */
export function stripAgentNamePrefix(title: string | undefined): string | undefined {
  if (!title) {
    return title;
  }
  const match = NAME_PREFIX_PATTERN.exec(title);
  if (!match) {
    return title;
  }
  const [, candidate, rest] = match;
  if (!POOL_NAMES.has(candidate)) {
    return title;
  }
  return rest.trim();
}
