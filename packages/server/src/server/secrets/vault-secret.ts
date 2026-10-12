import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Secrets stored in the Aside vault instead of on disk. A config value of the
 * form `aside://<account>/<itemId>` names the item; the daemon reads its
 * password field through the `aside-vault` CLI once per daemon run (warmed at
 * startup, see warmVaultSecrets) and keeps the value only in memory. A
 * rotated secret takes effect on the next daemon start. Plain values pass
 * through unchanged, so a field can hold either a key or a reference.
 *
 * The reference is safe to replicate across hosts (central config syncs to
 * peers); each host resolves it with its own `~/.config/aside-vault/recovery.env`.
 */
const VAULT_REF = /^aside:\/\/([^/\s]+)\/([A-Za-z0-9]+)$/;
const VAULT_REF_IN_TEXT = /aside:\/\/[^/\s]+\/[A-Za-z0-9]+/g;
const CLI_TIMEOUT_MS = 15_000;

export interface VaultSecretOptions {
  home?: string;
  /** Path to the aside-vault CLI; default ~/.local/bin/aside-vault, else PATH. */
  cliPath?: string;
}

/** The secret for `value`: read from the vault when it is an `aside://` reference. */
export type ResolveSecret = (value: string | undefined) => Promise<string | undefined>;

/** KEY=VALUE pairs from recovery.env (`export ` prefix and quotes allowed). */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

function runCli(cli: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(cli, args, { env, timeout: CLI_TIMEOUT_MS }, (error, stdout) => {
    // Never put CLI output in the error: on a partial failure it may hold the secret.
    if (error) {
      reject(new Error(`aside-vault ${args[0]} failed (exit ${error.code ?? "?"})`));
      return;
    }
    resolve(stdout);
  });
  return promise;
}

export function createVaultSecretResolver(options: VaultSecretOptions = {}): ResolveSecret {
  const home = options.home ?? homedir();
  // Successful reads live for the process; a failed read is retried on the next use.
  const cache = new Map<string, Promise<string>>();

  const fetchRef = async (account: string, itemId: string): Promise<string> => {
    const envFile = join(home, ".config", "aside-vault", "recovery.env");
    if (!existsSync(envFile)) {
      throw new Error(`Aside vault is not set up on this host (${envFile} is missing)`);
    }
    const localCli = join(home, ".local", "bin", "aside-vault");
    const cli = options.cliPath ?? (existsSync(localCli) ? localCli : "aside-vault");
    const stdout = await runCli(cli, ["get", itemId, "--account", account, "--field", "password"], {
      ...process.env,
      HOME: home,
      ...parseEnvFile(readFileSync(envFile, "utf8")),
    });
    const value = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!value) throw new Error(`Aside vault item ${itemId} has an empty password field`);
    return value;
  };

  return async (value) => {
    if (value === undefined) return undefined;
    const ref = value.trim();
    const match = VAULT_REF.exec(ref);
    if (!match) return value;
    let pending = cache.get(ref);
    if (!pending) {
      pending = fetchRef(match[1]!, match[2]!);
      cache.set(ref, pending);
      pending.catch(() => cache.delete(ref));
    }
    return pending;
  };
}

/** The daemon's one resolver: every service shares its cache, so each secret is read once per run. */
export const resolveVaultSecret: ResolveSecret = createVaultSecretResolver();

/**
 * Read every vault reference found in `values` (whole values or embedded, like
 * "Bearer aside://…") into the cache. Never throws; returns counts for logging.
 */
export async function warmVaultSecrets(
  values: readonly string[],
  resolve: ResolveSecret = resolveVaultSecret,
): Promise<{ loaded: number; failed: number }> {
  const refs = new Set(values.flatMap((value) => value.match(VAULT_REF_IN_TEXT) ?? []));
  const results = await Promise.allSettled([...refs].map((ref) => resolve(ref)));
  const failed = results.filter((result) => result.status === "rejected").length;
  return { loaded: results.length - failed, failed };
}
