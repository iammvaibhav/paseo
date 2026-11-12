/**
 * Browser devtools snippet that registers a mock stack's hosts in the Paseo web UI.
 *
 * The daemon's injected connection hint carries no password, so a password-protected
 * mock lands the app on the add-host form. Pasting this into the devtools console of
 * the mock's own web UI writes the stored host profile the app reads at boot
 * (StoredHostProfileSchema in packages/app/src/types/host-connection.ts), then reloads.
 * It merges by serverId, so re-pasting for a new run replaces the stale entry and
 * leaves every other host the browser already knows about untouched.
 */
export function buildConnectSnippet(stack) {
  const hosts = stack.hosts.map((h) => {
    const url = stack.reachable?.urls?.[h.name] || h.httpUrl;
    const endpoint = url.replace(/^https?:\/\//, "");
    const connectionId = `direct:${endpoint}`;
    const profile = {
      serverId: h.serverId,
      label: `verify ${stack.runId} ${h.name}`,
      connections: [
        {
          id: connectionId,
          type: "directTcp",
          endpoint,
          ...(stack.password ? { password: stack.password } : {}),
        },
      ],
      preferredConnectionId: connectionId,
      ...(stack.codeServer?.healthy ? { browserEditorUrl: stack.codeServer.url } : {}),
    };
    return profile;
  });

  // Runs in the browser. Kept dependency-free and idempotent.
  return [
    "(() => {",
    `  const incoming = ${JSON.stringify(hosts)};`,
    '  const key = "@paseo:daemon-registry";',
    "  const now = new Date().toISOString();",
    "  let existing = [];",
    "  try { existing = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}",
    "  const ids = new Set(incoming.map((h) => h.serverId));",
    "  const kept = existing.filter((h) => !ids.has(h.serverId));",
    "  const merged = kept.concat(incoming.map((h) => ({ ...h, createdAt: now, updatedAt: now })));",
    "  localStorage.setItem(key, JSON.stringify(merged));",
    "  console.log('Paseo verify: registered', incoming.map((h) => h.label).join(', '));",
    "  location.reload();",
    "})();",
  ].join("\n");
}
