import { randomUUID } from "node:crypto";

export type DownloadTokenKind = "file" | "directory";

export interface DownloadTokenEntry {
  token: string;
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  /** Byte size for files; 0 for directories (zip size is unknown until streamed). */
  size: number;
  kind: DownloadTokenKind;
  expiresAt: number;
}

interface DownloadTokenStoreOptions {
  ttlMs: number;
  now?: () => number;
}

export class DownloadTokenStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, DownloadTokenEntry>();

  constructor(options: DownloadTokenStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  issueToken(
    input: Omit<DownloadTokenEntry, "token" | "expiresAt" | "kind"> & {
      kind?: DownloadTokenKind;
    },
  ): DownloadTokenEntry {
    this.pruneExpired();
    const token = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const entry: DownloadTokenEntry = {
      ...input,
      kind: input.kind ?? "file",
      token,
      expiresAt,
    };
    this.tokens.set(token, entry);
    return entry;
  }

  consumeToken(token: string): DownloadTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry) {
      return null;
    }

    this.tokens.delete(token);

    if (entry.expiresAt <= this.now()) {
      return null;
    }

    return entry;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
