import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import {
  SECURE_INPUT_FIELD_NAME_PATTERN,
  SECURE_INPUT_PERMISSION_NAME,
  type SecureInputField,
  type SecureInputFieldType,
  type SecureInputForm,
} from "@getpaseo/protocol/secure-input/rpc-schemas";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { DaemonPermissionHandle, DaemonPermissionHost } from "../agent/daemon-permissions.js";

/** Longest value a field accepts; anything larger is not a password, OTP or key. */
export const SECURE_INPUT_MAX_VALUE_BYTES = 64 * 1024;
export const SECURE_INPUT_MAX_FIELDS = 10;

export interface SecureInputFieldInput {
  name: string;
  label: string;
  type: SecureInputFieldType;
  secret?: boolean;
  required?: boolean;
  description?: string;
  placeholder?: string;
}

/** Store one secret field in Aside vault (`aside-vault add`), straight from the daemon. */
export interface SecureInputVaultInput {
  field: string;
  account: string;
  title: string;
  category?: "login" | "api" | "note" | "card" | "ssh" | "bank";
  subtitle?: string;
  url?: string;
  /** A non-secret field whose value becomes the item's username. */
  usernameField?: string;
}

export interface SecureInputAsk {
  title: string;
  description?: string;
  fields: SecureInputFieldInput[];
  /** How long to wait for the user. */
  timeoutMs: number;
  /** How long secret files and refs live after submit. */
  ttlMs: number;
  vault?: SecureInputVaultInput;
  signal?: AbortSignal;
}

export interface SecureInputSecretRef {
  /** 0600 file holding exactly the value, no trailing newline. */
  file: string;
  /** Variable name the env file exports. */
  env: string;
  /** Pass as `secretRef` to browser_fill. */
  secretRef: string;
}

export type SecureInputOutcome =
  | {
      status: "submitted";
      ref: string;
      expiresAt: string;
      /** Non-secret fields only. */
      values: Record<string, string>;
      secrets: Record<string, SecureInputSecretRef>;
      /** Shell file of `export NAME='value'` lines for the secret fields. */
      envFile: string | null;
      vault?: { ok: true; itemId: string } | { ok: false; error: string };
    }
  | { status: "cancelled" | "timeout"; ref: string; reason?: string };

export type SecureInputSubmitResult = { accepted: true } | { accepted: false; error: string };

export type VaultWriter = (input: {
  account: string;
  category: string;
  title: string;
  subtitle?: string;
  url?: string;
  username?: string;
  secret: string;
}) => Promise<string>;

interface PendingRequest {
  agentId: string;
  fields: SecureInputField[];
  ttlMs: number;
  vault?: SecureInputVaultInput;
  handle: DaemonPermissionHandle | null;
  submitting: boolean;
  finish: (outcome: SecureInputOutcome, resolution?: AgentPermissionResponse) => void;
}

interface StoredSecrets {
  agentId: string;
  dir: string;
  values: Map<string, Buffer>;
  timer: NodeJS.Timeout;
}

/**
 * Where secret files live: memory-backed when the host has it (XDG_RUNTIME_DIR,
 * then /dev/shm), else the per-user temp dir. One directory per daemon home, so
 * a dev daemon never wipes the main daemon's files.
 */
export async function resolveSecureInputRoot(paseoHome: string): Promise<string> {
  const tag = createHash("sha256").update(path.resolve(paseoHome)).digest("hex").slice(0, 12);
  const candidates = [
    process.env.XDG_RUNTIME_DIR?.trim(),
    process.platform === "linux" ? "/dev/shm" : undefined,
  ];
  let base = os.tmpdir();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const isDir = await fsp.stat(candidate).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    if (isDir) {
      base = candidate;
      break;
    }
  }
  return path.join(base, `paseo-secure-input-${tag}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs `aside-vault add … --secret-stdin`; the value goes over stdin, never argv. */
export const writeToAsideVault: VaultWriter = (input) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const args = [
    "add",
    "--account",
    input.account,
    "--category",
    input.category,
    "--title",
    input.title,
    ...(input.subtitle ? ["--subtitle", input.subtitle] : []),
    ...(input.url ? ["--url", input.url] : []),
    ...(input.username ? ["--username", input.username] : []),
    "--secret-stdin",
  ];
  // The fleet installs aside-vault in ~/.local/bin, which a service PATH may lack.
  const pathWithLocalBin = [process.env.PATH, path.join(os.homedir(), ".local", "bin")]
    .filter(Boolean)
    .join(path.delimiter);
  const child = spawn(process.env.ASIDE_VAULT_BIN || "aside-vault", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pathWithLocalBin },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", reject);
  child.on("close", (code) => {
    const itemId = stdout.trim().split(/\s+/)[0];
    if (code === 0 && itemId) resolve(itemId);
    else reject(new Error(`aside-vault add exited ${code}: ${stderr.trim().slice(-300)}`));
  });
  child.stdin.end(input.secret);
  return promise;
};

export class SecureInputService {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stored = new Map<string, StoredSecrets>();
  private readonly permissions: DaemonPermissionHost;
  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly vaultWriter: VaultWriter;

  constructor(options: {
    permissions: DaemonPermissionHost;
    rootDir: string;
    logger: Logger;
    vaultWriter?: VaultWriter;
  }) {
    this.permissions = options.permissions;
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.vaultWriter = options.vaultWriter ?? writeToAsideVault;
  }

  /** Clears files a previous daemon run left behind (a crash skips close()). */
  async start(): Promise<void> {
    await fsp.rm(this.rootDir, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    for (const request of this.pending.values()) {
      request.finish(
        { status: "cancelled", ref: "", reason: "The daemon stopped" },
        { behavior: "deny", message: "The daemon stopped" },
      );
    }
    for (const ref of this.stored.keys()) await this.dropStored(ref);
    await fsp.rm(this.rootDir, { recursive: true, force: true });
  }

  /** Shows the form in the agent's chat and resolves once the user submits or cancels, or on timeout. */
  async request(agentId: string, ask: SecureInputAsk): Promise<SecureInputOutcome> {
    const fields = normalizeFields(ask.fields);
    validateVault(ask.vault, fields);
    const ref = `si_${randomBytes(12).toString("hex")}`;
    const expiresAt = new Date(Date.now() + ask.timeoutMs).toISOString();
    const form: SecureInputForm = { fields, expiresAt };

    const { promise, resolve } = Promise.withResolvers<SecureInputOutcome>();
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () =>
      entry.finish(
        { status: "cancelled", ref, reason: "The agent stopped waiting" },
        { behavior: "deny", message: "The agent stopped waiting" },
      );
    const entry: PendingRequest = {
      agentId,
      fields,
      ttlMs: ask.ttlMs,
      ...(ask.vault ? { vault: ask.vault } : {}),
      handle: null,
      submitting: false,
      finish: (outcome, resolution) => {
        if (!this.pending.has(ref)) return;
        this.pending.delete(ref);
        clearTimeout(timer);
        ask.signal?.removeEventListener("abort", onAbort);
        if (resolution) entry.handle?.settle(resolution);
        resolve({ ...outcome, ref });
      },
    };
    entry.handle = this.permissions.requestDaemonPermission(
      agentId,
      {
        id: ref,
        name: SECURE_INPUT_PERMISSION_NAME,
        kind: "other",
        title: ask.title,
        ...(ask.description ? { description: ask.description } : {}),
        metadata: { secureInput: form },
        // Clients that predate the secure input card can only cancel it.
        actions: [{ id: "cancel", label: "Cancel", behavior: "deny", variant: "secondary" }],
      },
      (response) => {
        if (response.behavior === "allow") {
          throw new Error("Fill this form in the Paseo app; it cannot be answered here");
        }
        // AgentManager settles the card itself after this returns.
        entry.finish({ status: "cancelled", ref, reason: response.message ?? "Cancelled" });
      },
    );
    this.pending.set(ref, entry);
    timer = setTimeout(
      () =>
        entry.finish(
          { status: "timeout", ref },
          { behavior: "deny", message: "Timed out waiting for input" },
        ),
      ask.timeoutMs,
    );
    timer.unref?.();
    if (ask.signal?.aborted) onAbort();
    else ask.signal?.addEventListener("abort", onAbort, { once: true });
    return await promise;
  }

  /** The app's form submission. Values never leave this method except into files, memory and the vault. */
  async submit(
    agentId: string,
    ref: string,
    values: Record<string, string>,
  ): Promise<SecureInputSubmitResult> {
    const request = this.pending.get(ref);
    if (!request || request.agentId !== agentId) {
      return { accepted: false, error: "This request is no longer waiting for input" };
    }
    if (request.submitting) return { accepted: false, error: "Already submitting" };
    const invalid = validateValues(request.fields, values);
    if (invalid) return { accepted: false, error: invalid };

    request.submitting = true;
    try {
      const expiresAt = new Date(Date.now() + request.ttlMs).toISOString();
      const plain: Record<string, string> = {};
      const secretValues = new Map<string, Buffer>();
      for (const field of request.fields) {
        const value = values[field.name];
        if (value === undefined || value === "") continue;
        if (field.secret) secretValues.set(field.name, Buffer.from(value, "utf8"));
        else plain[field.name] = value;
      }
      const secrets = await this.storeSecrets(ref, agentId, secretValues, request.ttlMs);
      const vault = request.vault
        ? await this.saveToVault(request.vault, secretValues, plain)
        : undefined;
      request.finish(
        {
          status: "submitted",
          ref,
          expiresAt,
          values: plain,
          secrets: secrets.refs,
          envFile: secrets.envFile,
          ...(vault ? { vault } : {}),
        },
        { behavior: "allow" },
      );
      return { accepted: true };
    } catch (error) {
      request.submitting = false;
      await this.dropStored(ref);
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), ref },
        "secure input submit failed",
      );
      return { accepted: false, error: "Could not store the values on the host" };
    }
  }

  /** The value behind `secretRef` (`<ref>/<field>`), for daemon-side consumers such as browser_fill. */
  resolveSecret(agentId: string, secretRef: string): string | null {
    const [ref, field] = secretRef.split("/", 2);
    const stored = ref ? this.stored.get(ref) : undefined;
    if (!stored || stored.agentId !== agentId || !field) return null;
    return stored.values.get(field)?.toString("utf8") ?? null;
  }

  /** Deletes a submission's files and values now. False when the ref is unknown or already gone. */
  async release(agentId: string, ref: string): Promise<boolean> {
    const stored = this.stored.get(ref);
    if (!stored || stored.agentId !== agentId) return false;
    await this.dropStored(ref);
    return true;
  }

  private async storeSecrets(
    ref: string,
    agentId: string,
    values: Map<string, Buffer>,
    ttlMs: number,
  ): Promise<{ refs: Record<string, SecureInputSecretRef>; envFile: string | null }> {
    if (values.size === 0) return { refs: {}, envFile: null };
    await ensurePrivateDir(this.rootDir);
    const dir = path.join(this.rootDir, ref);
    await fsp.mkdir(dir, { mode: 0o700 });
    const timer = setTimeout(() => void this.dropStored(ref), ttlMs);
    timer.unref?.();
    this.stored.set(ref, { agentId, dir, values, timer });

    const refs: Record<string, SecureInputSecretRef> = {};
    const envLines: string[] = [];
    for (const [name, value] of values) {
      const file = path.join(dir, name);
      await fsp.writeFile(file, value, { mode: 0o600, flag: "wx" });
      const env = name.toUpperCase();
      refs[name] = { file, env, secretRef: `${ref}/${name}` };
      envLines.push(`export ${env}=${shellQuote(value.toString("utf8"))}`);
    }
    const envFile = path.join(dir, ".env.sh");
    await fsp.writeFile(envFile, `${envLines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    return { refs, envFile };
  }

  private async saveToVault(
    vault: SecureInputVaultInput,
    secrets: Map<string, Buffer>,
    plain: Record<string, string>,
  ): Promise<{ ok: true; itemId: string } | { ok: false; error: string }> {
    const secret = secrets.get(vault.field);
    if (!secret) return { ok: false, error: `${vault.field} was left empty` };
    try {
      const username = vault.usernameField ? plain[vault.usernameField] : undefined;
      const itemId = await this.vaultWriter({
        account: vault.account,
        category: vault.category ?? "login",
        title: vault.title,
        ...(vault.subtitle ? { subtitle: vault.subtitle } : {}),
        ...(vault.url ? { url: vault.url } : {}),
        ...(username ? { username } : {}),
        secret: secret.toString("utf8"),
      });
      return { ok: true, itemId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async dropStored(ref: string): Promise<void> {
    const stored = this.stored.get(ref);
    if (!stored) return;
    this.stored.delete(ref);
    clearTimeout(stored.timer);
    for (const value of stored.values.values()) value.fill(0);
    await fsp.rm(stored.dir, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn({ err: error, ref }, "Failed to remove secure input files");
    });
  }
}

/**
 * The root is created 0700 by this process. A symlink or a directory owned by
 * someone else (a pre-created path in a shared /dev/shm) is refused.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fsp.lstat(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private directory owned by the daemon`);
  }
}

function normalizeFields(inputs: SecureInputFieldInput[]): SecureInputField[] {
  if (inputs.length === 0 || inputs.length > SECURE_INPUT_MAX_FIELDS) {
    throw new Error(`Ask for 1 to ${SECURE_INPUT_MAX_FIELDS} fields`);
  }
  const seen = new Set<string>();
  return inputs.map((input) => {
    if (!SECURE_INPUT_FIELD_NAME_PATTERN.test(input.name)) {
      throw new Error(`Field name "${input.name}" must match ${SECURE_INPUT_FIELD_NAME_PATTERN}`);
    }
    if (seen.has(input.name)) throw new Error(`Field name "${input.name}" is repeated`);
    seen.add(input.name);
    return {
      name: input.name,
      label: input.label,
      type: input.type,
      // Secret unless the agent says otherwise: a plain-text echo must be asked for.
      secret: input.secret ?? true,
      required: input.required ?? true,
      ...(input.description ? { description: input.description } : {}),
      ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    };
  });
}

function validateVault(vault: SecureInputVaultInput | undefined, fields: SecureInputField[]): void {
  if (!vault) return;
  const target = fields.find((field) => field.name === vault.field);
  if (!target?.secret) throw new Error(`vault.field must name a secret field`);
  if (vault.usernameField) {
    const username = fields.find((field) => field.name === vault.usernameField);
    if (!username || username.secret) {
      throw new Error("vault.usernameField must name a non-secret field");
    }
  }
}

function validateValues(fields: SecureInputField[], values: Record<string, string>): string | null {
  const names = new Set(fields.map((field) => field.name));
  for (const name of Object.keys(values)) {
    if (!names.has(name)) return `Unknown field ${name}`;
  }
  for (const field of fields) {
    const value = values[field.name] ?? "";
    if (field.required && value === "") return `${field.label} is required`;
    if (Buffer.byteLength(value, "utf8") > SECURE_INPUT_MAX_VALUE_BYTES) {
      return `${field.label} is too long`;
    }
  }
  return null;
}
