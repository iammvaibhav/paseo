import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";

interface FileUploadStoreOptions {
  paseoHome: string;
  staleUploadTimeoutMs?: number;
}

interface PendingUpload {
  requestId: string;
  id: string;
  source: object;
  completed: boolean;
  finished(response: FileUploadResponse | null): void;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  cleanup?: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly paseoHome: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly defaultSource = {};
  private readonly pending = new Map<object, Map<string, PendingUpload>>();

  constructor(options: FileUploadStoreOptions) {
    this.paseoHome = options.paseoHome;
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
  }

  hasPending(requestId: string, source?: object): boolean {
    if (source) {
      return this.pending.get(source)?.has(requestId) ?? false;
    }
    for (const uploads of this.pending.values()) {
      if (uploads.has(requestId)) return true;
    }
    return false;
  }

  beginUpload(
    request: FileUploadRequest,
    source: object = this.defaultSource,
    finished: (response: FileUploadResponse | null) => void = () => {},
  ): () => Promise<void> {
    const existingUpload = this.pending.get(source)?.get(request.requestId);
    if (existingUpload) void this.cancel(existingUpload).catch(() => {});
    const fileName = sanitizeFileName(request.fileName);
    const id = `upload_${randomUUID()}`;
    const uploadDir = join(this.paseoHome, "uploads", id);
    const upload: PendingUpload = {
      requestId: request.requestId,
      id,
      source,
      completed: false,
      finished,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
      staleTimeout: this.createStaleUploadTimeout(source, request.requestId),
      queue: Promise.resolve(),
    };
    const uploads = this.pending.get(source) ?? new Map<string, PendingUpload>();
    uploads.set(request.requestId, upload);
    this.pending.set(source, uploads);
    return () => this.cancel(upload);
  }

  async receiveFrame(
    frame: FileTransferFrame,
    source: object = this.defaultSource,
  ): Promise<FileUploadResponse | null> {
    const upload = this.pending.get(source)?.get(frame.requestId);
    if (!upload) {
      return null;
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    void operation.then(
      (response) => {
        if (response) upload.finished(response);
        return undefined;
      },
      () => upload.finished(null),
    );
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.pending.get(upload.source)?.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    await mkdir(join(this.paseoHome, "uploads", upload.id), { recursive: true });
    await writeFile(upload.path, new Uint8Array());
    upload.started = true;
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<FileUploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await this.removeUploadDirectory(upload);
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    upload.completed = true;
    // The mime type is recorded beside the upload directory so the file can be
    // resolved by id later (readStoredUpload) without trusting its extension.
    await writeFile(
      uploadMetadataPath(this.paseoHome, upload.id),
      JSON.stringify({ fileName: upload.fileName, mimeType: upload.mimeType }),
    );
    return buildUploadResponse(upload, null);
  }

  private createStaleUploadTimeout(
    source: object,
    requestId: string,
  ): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const upload = this.pending.get(source)?.get(requestId);
      if (upload) void this.cancel(upload).catch(() => {});
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.source, upload.requestId);
  }

  private cancel(upload: PendingUpload): Promise<void> {
    if (upload.cleanup) return upload.cleanup;
    this.clearPendingUpload(upload);
    upload.cleanup = upload.queue.then(async () => {
      if (!upload.completed) await this.removeUploadDirectory(upload);
      return undefined;
    });
    upload.finished(null);
    return upload.cleanup;
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    const uploads = this.pending.get(upload.source);
    if (uploads?.get(upload.requestId) === upload) uploads.delete(upload.requestId);
    if (uploads?.size === 0) this.pending.delete(upload.source);
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await this.removeUploadDirectory(upload);
  }

  private async removeUploadDirectory(upload: PendingUpload): Promise<void> {
    await rm(join(this.paseoHome, "uploads", upload.id), { recursive: true, force: true });
    await rm(uploadMetadataPath(this.paseoHome, upload.id), { force: true });
  }
}

export type StoredUpload = NonNullable<FileUploadResponse["payload"]["file"]>;

const UPLOAD_ID_PATTERN = /^upload_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uploadMetadataPath(paseoHome: string, id: string): string {
  return join(paseoHome, "uploads", `${id}.json`);
}

/**
 * Looks up a completed upload in this daemon's attachment store by id.
 * Null when the id is malformed or names no stored file.
 */
export async function readStoredUpload(
  paseoHome: string,
  id: string,
): Promise<StoredUpload | null> {
  if (!UPLOAD_ID_PATTERN.test(id)) return null;
  const uploadDir = join(paseoHome, "uploads", id);
  const metadata = await readFile(uploadMetadataPath(paseoHome, id), "utf8")
    .then((text) => JSON.parse(text) as { fileName?: unknown; mimeType?: unknown })
    .catch(() => null);
  let fileName = typeof metadata?.fileName === "string" ? metadata.fileName : null;
  // Uploads stored before the metadata file existed hold exactly one file.
  if (!fileName) {
    const entries = await readdir(uploadDir).catch(() => []);
    fileName = entries.length === 1 ? entries[0] : null;
  }
  if (!fileName) return null;
  const path = join(uploadDir, fileName);
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile()) return null;
  return {
    type: "uploaded_file",
    id,
    fileName,
    mimeType:
      typeof metadata?.mimeType === "string" ? metadata.mimeType : "application/octet-stream",
    size: fileStat.size,
    path,
  };
}

export interface ChunkedUploadProgress {
  receivedBytes: number;
  size: number;
  /** The stored file once the last byte arrived; null while chunks are outstanding. */
  file: StoredUpload | null;
}

/**
 * Uploads that arrive as a series of byte chunks over a request/response
 * transport (the MCP upload tool), written through a FileUploadStore so they
 * land in the same attachment store as WebSocket uploads. The upload completes
 * when the declared size has arrived; idle uploads expire with the store's
 * stale-upload timeout.
 */
export class ChunkedUploadSessions {
  private readonly source = {};
  private readonly sessions = new Map<string, { size: number; receivedBytes: number }>();

  constructor(private readonly store: FileUploadStore) {}

  async start(input: { fileName: string; mimeType: string; size: number }): Promise<string> {
    const uploadId = `chunked_${randomUUID()}`;
    const modifiedAt = new Date().toISOString();
    this.store.beginUpload(
      { type: "file.upload.request", requestId: uploadId, modifiedAt, ...input },
      this.source,
      () => this.sessions.delete(uploadId),
    );
    this.sessions.set(uploadId, { size: input.size, receivedBytes: 0 });
    await this.store.receiveFrame(
      {
        opcode: FileTransferOpcode.FileBegin,
        requestId: uploadId,
        metadata: { mime: input.mimeType, size: input.size, encoding: "binary", modifiedAt },
        payload: new Uint8Array(),
      },
      this.source,
    );
    return uploadId;
  }

  async append(uploadId: string, bytes: Uint8Array): Promise<ChunkedUploadProgress> {
    const session = this.sessions.get(uploadId);
    if (!session || !this.store.hasPending(uploadId, this.source)) {
      this.sessions.delete(uploadId);
      throw new Error(`unknown or expired uploadId "${uploadId}"; start a new upload`);
    }
    const receivedBytes = session.receivedBytes + bytes.byteLength;
    const response = await this.store.receiveFrame(
      { opcode: FileTransferOpcode.FileChunk, requestId: uploadId, payload: bytes },
      this.source,
    );
    if (response?.payload.error) {
      this.sessions.delete(uploadId);
      throw new Error(
        receivedBytes > session.size
          ? `upload exceeds the declared size: ${receivedBytes} of ${session.size} bytes`
          : response.payload.error,
      );
    }
    session.receivedBytes = receivedBytes;
    if (receivedBytes < session.size) {
      return { receivedBytes, size: session.size, file: null };
    }
    this.sessions.delete(uploadId);
    const done = await this.store.receiveFrame(
      { opcode: FileTransferOpcode.FileEnd, requestId: uploadId, payload: new Uint8Array() },
      this.source,
    );
    if (!done?.payload.file) {
      throw new Error(done?.payload.error ?? "upload could not be completed");
    }
    return { receivedBytes, size: session.size, file: done.payload.file };
  }
}

function buildUploadResponse(upload: PendingUpload, error: string | null): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: {
      requestId: upload.requestId,
      file: error
        ? null
        : {
            type: "uploaded_file",
            id: upload.id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            size: upload.size,
            path: upload.path,
          },
      error,
    },
  };
}

// Most file systems cap a single file name at 255 bytes.
const MAX_FILE_NAME_BYTES = 255;

// Keeps the client's file name, replacing only what cannot appear in a single
// file name on Linux, macOS, or Windows.
function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
    .trim();
  return fitFileNameLength(name.length > 0 && name !== "." && name !== ".." ? name : "upload");
}

function fitFileNameLength(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILE_NAME_BYTES) return name;
  const extension = extname(name);
  const keptExtension = Buffer.byteLength(extension) < MAX_FILE_NAME_BYTES ? extension : "";
  let stem = "";
  for (const char of name.slice(0, name.length - keptExtension.length)) {
    if (Buffer.byteLength(stem + char + keptExtension) > MAX_FILE_NAME_BYTES) break;
    stem += char;
  }
  return stem + keptExtension;
}
