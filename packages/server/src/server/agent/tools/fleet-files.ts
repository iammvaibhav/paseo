import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ensureValidJson } from "../../json-utils.js";
import { AgentAttachmentSchema, type AgentAttachment } from "../../messages.js";
import {
  readStoredUpload,
  type ChunkedUploadProgress,
  type ChunkedUploadSessions,
  type StoredUpload,
} from "../../file-upload/index.js";
import { fetchProofMediaLocal, type ProofMediaFetchResult } from "../../mission-control/media.js";
import {
  resolvePeerDaemonClient,
  resolveTargetHost,
  type RegisterFleetControlToolsOptions,
} from "./fleet-control-tools.js";
import type { PaseoToolResult } from "./types.js";

/** Largest file fleet_upload_file accepts (sum of all chunks). */
export const FLEET_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const FILE_ID_DESCRIPTION =
  "fileId returned by fleet_upload_file (a file in this daemon's upload store).";

/** A native image: inline base64, or a file uploaded earlier with fleet_upload_file. */
export const FleetImageInputSchema = z.union([
  z.object({
    data: z.string().min(1).describe("Base64 image bytes, no data: prefix."),
    mimeType: z.string().min(1),
  }),
  z.object({ fileId: z.string().min(1).describe(FILE_ID_DESCRIPTION) }),
]);
export type FleetImageInput = z.infer<typeof FleetImageInputSchema>;

export interface NativeImage {
  data: string;
  mimeType: string;
}

/** An attachment descriptor, or an uploaded_file named only by its fileId. */
export const FleetAttachmentInputSchema = z.union([
  AgentAttachmentSchema,
  z.object({
    type: z.literal("uploaded_file"),
    id: z.string().min(1).describe(FILE_ID_DESCRIPTION),
  }),
]);
export type FleetAttachmentInput = z.infer<typeof FleetAttachmentInputSchema>;

function decodeBase64(data: string, field: string): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (compact.startsWith("data:")) {
    throw new Error(`${field} must be bare base64; remove the "data:...;base64," prefix`);
  }
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    throw new Error(`${field} is not valid base64`);
  }
  return Buffer.from(compact, "base64");
}

async function requireStoredUpload(
  paseoHome: string | undefined,
  id: string,
): Promise<StoredUpload> {
  const stored = paseoHome ? await readStoredUpload(paseoHome, id) : null;
  if (!stored) {
    throw new Error(
      `fileId "${id}" is not in this host's upload store; upload the file with fleet_upload_file first`,
    );
  }
  return stored;
}

/** Turns image inputs into native images; fileIds must name stored image files. */
export async function resolveFleetImages(
  images: readonly FleetImageInput[] | undefined,
  paseoHome: string | undefined,
): Promise<NativeImage[] | undefined> {
  if (!images || images.length === 0) return undefined;
  return Promise.all(
    images.map(async (image): Promise<NativeImage> => {
      if ("data" in image) {
        decodeBase64(image.data, "images[].data");
        return { data: image.data, mimeType: image.mimeType };
      }
      const stored = await requireStoredUpload(paseoHome, image.fileId);
      if (!stored.mimeType.startsWith("image/")) {
        throw new Error(
          `fileId "${image.fileId}" is ${stored.mimeType}, not an image; pass it in attachments as {type: "uploaded_file", id} instead`,
        );
      }
      const bytes = await readFile(stored.path);
      return { data: bytes.toString("base64"), mimeType: stored.mimeType };
    }),
  );
}

/**
 * Resolves uploaded_file attachments against this host: an id in the upload
 * store wins; otherwise the descriptor's path must exist here. Other
 * attachment types pass through.
 */
export async function resolveFleetAttachments(
  attachments: readonly FleetAttachmentInput[] | undefined,
  paseoHome: string | undefined,
): Promise<AgentAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return undefined;
  return Promise.all(
    attachments.map(async (attachment): Promise<AgentAttachment> => {
      if (attachment.type !== "uploaded_file") return attachment;
      const stored = paseoHome ? await readStoredUpload(paseoHome, attachment.id) : null;
      if (stored) return stored;
      if (!("path" in attachment)) {
        return requireStoredUpload(paseoHome, attachment.id);
      }
      const fileStat = await stat(attachment.path).catch(() => null);
      if (!fileStat?.isFile()) {
        throw new Error(
          `uploaded_file "${attachment.fileName}" (${attachment.id}) does not exist on this host at ${attachment.path}; upload it with fleet_upload_file and pass the returned fileId`,
        );
      }
      return attachment;
    }),
  );
}

/**
 * A peer cannot open this host's paths: copy each uploaded file into the
 * peer's upload store and point the descriptor at the peer's copy.
 */
export async function forwardUploadedFilesToPeer(
  attachments: readonly AgentAttachment[] | undefined,
  client: Pick<DaemonClient, "uploadFile">,
): Promise<AgentAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return undefined;
  const forwarded: AgentAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "uploaded_file") {
      forwarded.push(attachment);
      continue;
    }
    const bytes = await readFile(attachment.path);
    const result = await client.uploadFile({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      bytes,
    });
    if (!result.file) {
      throw new Error(
        `Could not copy "${attachment.fileName}" to the target host: ${result.error ?? "upload failed"}`,
      );
    }
    forwarded.push(result.file);
  }
  return forwarded;
}

/** Writes native images into this host's upload store (for text-only deliveries). */
export async function storeImagesAsUploads(
  images: readonly NativeImage[] | undefined,
  uploads: ChunkedUploadSessions | null | undefined,
): Promise<StoredUpload[]> {
  if (!images || images.length === 0) return [];
  if (!uploads) throw new Error("This host has no upload store for images");
  const stored: StoredUpload[] = [];
  for (const [index, image] of images.entries()) {
    const bytes = decodeBase64(image.data, "images[].data");
    const extension = image.mimeType.split("/")[1]?.split("+")[0] || "bin";
    const uploadId = await uploads.start({
      fileName: `image-${index + 1}.${extension}`,
      mimeType: image.mimeType,
      size: bytes.byteLength,
    });
    const { file } = await uploads.append(uploadId, bytes);
    if (!file) throw new Error("image upload did not complete");
    stored.push(file);
  }
  return stored;
}

function errorResult(text: string): PaseoToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export interface RegisterFleetFileToolsOptions extends RegisterFleetControlToolsOptions {
  paseoHome?: string;
  chunkedUploads?: ChunkedUploadSessions | null;
}

/** Registers fleet_upload_file and fleet_read_image; a host without an upload store offers neither. */
export function registerFleetFileTools(options: RegisterFleetFileToolsOptions): void {
  const { chunkedUploads } = options;
  if (!options.paseoHome || !chunkedUploads) return;

  options.registerTool(
    "fleet_upload_file",
    {
      title: "Upload a file",
      description:
        "Put a file (for example a screenshot) into this daemon's upload store and get a fileId back. " +
        "Pass the fileId as images: [{fileId}] to fleet_create_agent or fleet_send_prompt, or as " +
        'attachments: [{type: "uploaded_file", id: fileId}] to fleet_send_prompt; agents on other hosts ' +
        "receive their own copy. Small files: one call with fileName, mimeType and data. Large files: " +
        "send base64 chunks of up to a few MB; the first call also gives size (total bytes), the next " +
        `calls pass the returned uploadId. The file is stored once size bytes arrived. Max ${FLEET_UPLOAD_MAX_BYTES / 1024 / 1024} MB; ` +
        "an upload idle for 10 minutes is discarded.",
      inputSchema: {
        data: z
          .string()
          .describe("Base64 bytes of this chunk (or of the whole file), no data: prefix."),
        fileName: z.string().min(1).optional().describe("File name; required on the first call."),
        mimeType: z
          .string()
          .min(1)
          .optional()
          .describe("MIME type, e.g. image/png; required on the first call."),
        size: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Total file size in bytes, on the first call of a chunked upload. Omit when data is the whole file.",
          ),
        uploadId: z
          .string()
          .min(1)
          .optional()
          .describe("uploadId from the previous call, to append the next chunk."),
      },
      outputSchema: {
        uploadId: z.string(),
        receivedBytes: z.number(),
        size: z.number(),
        complete: z.boolean(),
        fileId: z.string().optional(),
        fileName: z.string().optional(),
        mimeType: z.string().optional(),
        guidance: z.string(),
      },
    },
    async (input: {
      data: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
      uploadId?: string;
    }) => {
      let bytes: Buffer;
      try {
        bytes = decodeBase64(input.data, "data");
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      let uploadId = input.uploadId;
      if (!uploadId) {
        if (!input.fileName || !input.mimeType) {
          return errorResult("fileName and mimeType are required to start an upload");
        }
        const size = input.size ?? bytes.byteLength;
        if (size > FLEET_UPLOAD_MAX_BYTES) {
          return errorResult(
            `size ${size} exceeds the ${FLEET_UPLOAD_MAX_BYTES / 1024 / 1024} MB upload limit`,
          );
        }
        uploadId = await chunkedUploads.start({
          fileName: input.fileName,
          mimeType: input.mimeType,
          size,
        });
      }
      let progress: ChunkedUploadProgress;
      try {
        progress = await chunkedUploads.append(uploadId, bytes);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      const { file } = progress;
      let guidance = `Send the next chunk with uploadId; ${progress.size - progress.receivedBytes} bytes to go.`;
      if (file?.mimeType.startsWith("image/")) {
        guidance = "Stored. Pass images: [{fileId}] to fleet_send_prompt or fleet_create_agent.";
      } else if (file) {
        guidance =
          'Stored. Pass attachments: [{type: "uploaded_file", id: fileId}] to fleet_send_prompt.';
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          uploadId,
          receivedBytes: progress.receivedBytes,
          size: progress.size,
          complete: file !== null,
          ...(file ? { fileId: file.id, fileName: file.fileName, mimeType: file.mimeType } : {}),
          guidance,
        }),
      };
    },
  );

  options.registerTool(
    "fleet_read_image",
    {
      title: "Read an image file",
      description:
        "Return an image file from any host in the fleet as image content, for example a screenshot an agent " +
        "saved or an image proof path from fleet_context. Give the absolute path plus the agentId that " +
        "produced it (its host is resolved) or the host. Images only, up to 10 MB.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path of the image on its host."),
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe("Agent that produced the file; its host is used. Fleet-wide, no host needed."),
        host: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Host holding the file: a peer name, or 'local'. Default: the agent's host, else local.",
          ),
      },
    },
    async (input: { path: string; agentId?: string; host?: string }) => {
      if (!isAbsolute(input.path)) {
        return errorResult(`path must be absolute; got "${input.path}"`);
      }
      let host = input.host ?? "local";
      let isLocal = options.isFleetLocalTarget(host);
      if (input.agentId) {
        const resolved = await resolveTargetHost(input.agentId, input.host, options);
        if (resolved.error) {
          return errorResult(`${resolved.error}. ${resolved.guidance ?? ""}`.trim());
        }
        host = resolved.host;
        isLocal = resolved.isLocal;
      }
      let fetched: ProofMediaFetchResult;
      if (isLocal) {
        fetched = await fetchProofMediaLocal({ path: input.path });
      } else {
        const peer = resolvePeerDaemonClient(host, options);
        if (!peer.client) {
          return errorResult(peer.error ?? `Host "${host}" is unreachable`);
        }
        try {
          fetched = await peer.client.missionControlMediaFetch({ host: "local", path: input.path });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errorResult(`Reading ${input.path} on host "${host}" failed: ${message}`);
        }
      }
      if (!fetched.ok || !fetched.data || !fetched.mimeType) {
        return errorResult(fetched.error ?? `Could not read ${input.path}`);
      }
      if (!fetched.mimeType.startsWith("image/")) {
        return errorResult(
          `${input.path} is ${fetched.mimeType}, not an image; fleet_read_image returns images only`,
        );
      }
      const hostDisplay = isLocal ? options.hostLabel : host;
      return {
        content: [
          { type: "image", data: fetched.data, mimeType: fetched.mimeType },
          {
            type: "text",
            text: `${fetched.fileName ?? input.path} (${fetched.mimeType}, ${fetched.sizeBytes ?? "?"} bytes) on ${hostDisplay}`,
          },
        ],
      };
    },
  );
}
