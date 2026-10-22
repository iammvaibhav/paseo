import { appendFile, rename, rm, writeFile } from "node:fs/promises";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileExplorerWriteRequest, FileExplorerWriteResponse } from "../messages.js";
import { prepareExplorerFileWrite, type ExplorerFileWriteDestination } from "./service.js";

interface PendingWrite {
  requestId: string;
  cwd: string;
  directoryPath: string;
  fileName: string;
  size: number;
  destination: ExplorerFileWriteDestination | null;
  receivedBytes: number;
  started: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
}

export class FileExplorerWriteStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly staleUploadTimeoutMs: number;
  private readonly pending = new Map<string, PendingWrite>();

  constructor(options?: { staleUploadTimeoutMs?: number }) {
    this.staleUploadTimeoutMs =
      options?.staleUploadTimeoutMs ?? FileExplorerWriteStore.defaultStaleUploadTimeoutMs;
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Synchronously registers a write so binary frames can arrive immediately after. */
  beginWrite(request: FileExplorerWriteRequest): void {
    const existing = this.pending.get(request.requestId);
    if (existing) {
      this.clearPending(existing);
      void existing.queue.then(() => this.removeTemp(existing));
    }

    const write: PendingWrite = {
      requestId: request.requestId,
      cwd: request.cwd,
      directoryPath: request.directoryPath?.trim() || ".",
      fileName: request.fileName,
      size: request.size,
      destination: null,
      receivedBytes: 0,
      started: false,
      staleTimeout: this.createStaleTimeout(request.requestId),
      queue: Promise.resolve(),
    };
    this.pending.set(request.requestId, write);
  }

  async receiveFrame(frame: FileTransferFrame): Promise<FileExplorerWriteResponse | null> {
    const write = this.pending.get(frame.requestId);
    if (!write) {
      return null;
    }
    this.refreshStaleTimeout(write);

    const operation = write.queue.then(() => this.applyFrame(write, frame));
    write.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    write: PendingWrite,
    frame: FileTransferFrame,
  ): Promise<FileExplorerWriteResponse | null> {
    if (this.pending.get(write.requestId) !== write) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(write);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(write, frame.payload);
        return null;
      }
      return await this.completeWrite(write);
    } catch (error) {
      await this.failWrite(write);
      return buildWriteResponse({
        requestId: write.requestId,
        cwd: write.cwd,
        path: null,
        fileName: write.destination?.fileName ?? write.fileName,
        size: null,
        error: getErrorMessage(error),
      });
    }
  }

  private async startWriting(write: PendingWrite): Promise<void> {
    write.destination = await prepareExplorerFileWrite({
      root: write.cwd,
      directoryPath: write.directoryPath,
      fileName: write.fileName,
    });
    await writeFile(write.destination.absoluteTempPath, new Uint8Array());
    write.started = true;
  }

  private async writeChunk(write: PendingWrite, bytes: Uint8Array): Promise<void> {
    if (!write.started || !write.destination) {
      throw new Error("Write chunks arrived before file begin.");
    }
    const nextReceivedBytes = write.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > write.size) {
      throw new Error(
        `Write exceeded declared size: expected ${write.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(write.destination.absoluteTempPath, bytes);
    write.receivedBytes += bytes.byteLength;
  }

  private async completeWrite(write: PendingWrite): Promise<FileExplorerWriteResponse> {
    this.clearPending(write);
    if (!write.destination) {
      return buildWriteResponse({
        requestId: write.requestId,
        cwd: write.cwd,
        path: null,
        fileName: write.fileName,
        size: null,
        error: "Write completed before file begin.",
      });
    }
    if (write.receivedBytes !== write.size) {
      await this.removeTemp(write);
      return buildWriteResponse({
        requestId: write.requestId,
        cwd: write.cwd,
        path: null,
        fileName: write.destination.fileName,
        size: null,
        error: `Write size mismatch: expected ${write.size}, received ${write.receivedBytes}.`,
      });
    }

    await rename(write.destination.absoluteTempPath, write.destination.absolutePath);
    return buildWriteResponse({
      requestId: write.requestId,
      cwd: write.cwd,
      path: write.destination.path,
      fileName: write.destination.fileName,
      size: write.size,
      error: null,
    });
  }

  private createStaleTimeout(requestId: string): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      this.expireStale(requestId);
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleTimeout(write: PendingWrite): void {
    clearTimeout(write.staleTimeout);
    write.staleTimeout = this.createStaleTimeout(write.requestId);
  }

  private expireStale(requestId: string): void {
    const write = this.pending.get(requestId);
    if (!write) {
      return;
    }
    this.clearPending(write);
    const cleanup = write.queue.then(
      () => this.removeTemp(write),
      () => this.removeTemp(write),
    );
    write.queue = cleanup.then(
      () => undefined,
      () => undefined,
    );
  }

  private clearPending(write: PendingWrite): void {
    clearTimeout(write.staleTimeout);
    if (this.pending.get(write.requestId) === write) {
      this.pending.delete(write.requestId);
    }
  }

  private async failWrite(write: PendingWrite): Promise<void> {
    this.clearPending(write);
    await this.removeTemp(write);
  }

  private async removeTemp(write: PendingWrite): Promise<void> {
    if (!write.destination) {
      return;
    }
    await rm(write.destination.absoluteTempPath, { force: true }).catch(() => undefined);
  }
}

function buildWriteResponse(input: {
  requestId: string;
  cwd: string;
  path: string | null;
  fileName: string | null;
  size: number | null;
  error: string | null;
}): FileExplorerWriteResponse {
  return {
    type: "file.explorer.write.response",
    payload: {
      requestId: input.requestId,
      cwd: input.cwd,
      path: input.path,
      fileName: input.fileName,
      size: input.size,
      error: input.error,
    },
  };
}
