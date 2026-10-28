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

/**
 * An attachment for fleet_create_agent / fleet_send_prompt: a file uploaded
 * earlier ({fileId}), a file's bytes inline ({name, mimeType, base64} or
 * {name, mimeType, text}), or a full attachment descriptor (composer
 * paste-through, including {type: "uploaded_file", id}). Inline files are
 * stored in this host's upload store and delivered as uploaded_file
 * attachments, so the agent gets a file path, never the bytes in its prompt.
 */
export const FleetAttachmentInputSchema = z.union([
  AgentAttachmentSchema,
  z.object({
    type: z.literal("uploaded_file"),
    id: z.string().min(1).describe(FILE_ID_DESCRIPTION),
  }),
  z.object({ fileId: z.string().min(1).describe(FILE_ID_DESCRIPTION) }),
  z.object({
    name: z.string().min(1).describe("File name, e.g. design.md or screenshot.png."),
    mimeType: z.string().min(1).describe("MIME type, e.g. text/markdown or image/png."),
    base64: z.string().min(1).describe("The file's bytes as base64, no data: prefix."),
  }),
  z.object({
    name: z.string().min(1).describe("File name, e.g. notes.md or build.log."),
    mimeType: z.string().min(1).describe("MIME type, e.g. text/markdown or text/plain."),
    text: z.string().describe("The file's content as UTF-8 text (text files only)."),
  }),
]);
export type FleetAttachmentInput = z.infer<typeof FleetAttachmentInputSchema>;

export const FLEET_ATTACHMENTS_DESCRIPTION =
  "Files for the agent, delivered as real attached files (the agent gets each file's path; images also " +
  "arrive as native images). Each item is {fileId} from fleet_upload_file, or the file inline as " +
  "{name, mimeType, base64} or, for text files, {name, mimeType, text}. Any file type: images, markdown, " +
  "logs, PDFs. Agents on another host get their own copy. Never paste a file or base64 into the prompt text.";

/** Longest initialPrompt / prompt the fleet tools accept, in characters. */
export const FLEET_PROMPT_MAX_CHARS = 64 * 1024;

/** A data: URI carrying base64 bytes (a pasted file or embedded image). */
const DATA_URI_PATTERN = /data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9.=+-]+)*;base64,[A-Za-z0-9+/]{16}/i;

const ATTACH_INSTEAD_GUIDANCE =
  "Hand files over as attachments instead: pass attachments: [{name, mimeType, base64}] (or " +
  "{name, mimeType, text} for text files), or upload with fleet_upload_file and pass attachments: [{fileId}]. " +
  "Keep the prompt to the instructions and refer to the attached file by name.";

/**
 * Rejects prompt text that carries file content: a base64 data: URI, or text
 * long enough to be a pasted document. Either would reach the model as raw
 * text in every later request of the session.
 */
export function assertFleetPromptText(text: string | undefined, field: string): void {
  if (!text) return;
  const dataUri = DATA_URI_PATTERN.exec(text);
  if (dataUri) {
    const mimeType = dataUri[0].slice("data:".length).split(";")[0];
    throw new Error(
      `${field} contains a base64 data: URI (${mimeType}) at character ${dataUri.index}; file content is ` +
        `not accepted in prompt text. ${ATTACH_INSTEAD_GUIDANCE} For a markdown file with embedded images, ` +
        "attach each image as its own file and reference it by name.",
    );
  }
  if (text.length > FLEET_PROMPT_MAX_CHARS) {
    throw new Error(
      `${field} is ${text.length} characters; the limit is ${FLEET_PROMPT_MAX_CHARS}. ` +
        `Long content such as a document or log belongs in a file. ${ATTACH_INSTEAD_GUIDANCE}`,
    );
  }
}

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
      if ("data" in image) return { data: image.data, mimeType: image.mimeType };
      const stored = await requireStoredUpload(paseoHome, image.fileId);
      if (!stored.mimeType.startsWith("image/")) {
        throw new Error(
          `fileId "${image.fileId}" is ${stored.mimeType}, not an image; pass it in attachments as {fileId} instead`,
        );
      }
      const bytes = await readFile(stored.path);
      return { data: bytes.toString("base64"), mimeType: stored.mimeType };
    }),
  );
}

/** Raster formats every provider accepts as a native image block. */
const NATIVE_IMAGE_MIME_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

/**
 * Native images for a prompt: the explicit images plus every uploaded_file
 * attachment in a native image format. The attachment stays in the prompt for
 * its path; the native copy is what the model sees and the user row renders.
 */
export async function resolveFleetPromptImages(
  images: readonly FleetImageInput[] | undefined,
  attachments: readonly AgentAttachment[] | undefined,
  paseoHome: string | undefined,
): Promise<NativeImage[] | undefined> {
  const explicit = (await resolveFleetImages(images, paseoHome)) ?? [];
  const attachedImages = await Promise.all(
    (attachments ?? []).flatMap((attachment) =>
      attachment.type === "uploaded_file" && NATIVE_IMAGE_MIME_TYPES[attachment.mimeType] === true
        ? [
            readFile(attachment.path).then(
              (bytes): NativeImage => ({
                data: bytes.toString("base64"),
                mimeType: attachment.mimeType,
              }),
            ),
          ]
        : [],
    ),
  );
  const all = [...explicit, ...attachedImages];
  return all.length > 0 ? all : undefined;
}

/**
 * Resolves attachment inputs against this host: fileIds and uploaded_file ids
 * must name a stored upload (or, for a full descriptor, a path that exists
 * here); inline files are written to the upload store first. Other
 * attachment types pass through.
 */
export async function resolveFleetAttachments(
  attachments: readonly FleetAttachmentInput[] | undefined,
  paseoHome: string | undefined,
  uploads: ChunkedUploadSessions | null | undefined,
): Promise<AgentAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return undefined;
  const resolved: AgentAttachment[] = [];
  // Sequential: inline files are written to disk one at a time.
  for (const [index, attachment] of attachments.entries()) {
    if ("fileId" in attachment) {
      resolved.push(await requireStoredUpload(paseoHome, attachment.fileId));
      continue;
    }
    if ("name" in attachment) {
      const bytes =
        "base64" in attachment
          ? decodeBase64(attachment.base64, `attachments[${index}].base64`)
          : Buffer.from(attachment.text, "utf8");
      resolved.push(
        await storeUpload(uploads, {
          fileName: attachment.name,
          mimeType: attachment.mimeType,
          bytes,
        }),
      );
      continue;
    }
    resolved.push(await resolveUploadedFileDescriptor(attachment, paseoHome));
  }
  return resolved;
}

async function resolveUploadedFileDescriptor(
  attachment: Exclude<FleetAttachmentInput, { fileId: string } | { name: string }>,
  paseoHome: string | undefined,
): Promise<AgentAttachment> {
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

/** Writes one file into this host's upload store, the same store fleet_upload_file uses. */
async function storeUpload(
  uploads: ChunkedUploadSessions | null | undefined,
  file: { fileName: string; mimeType: string; bytes: Buffer },
): Promise<StoredUpload> {
  if (!uploads) throw new Error("This host has no upload store for attachments");
  if (file.bytes.byteLength > FLEET_UPLOAD_MAX_BYTES) {
    throw new Error(
      `${file.fileName} is ${file.bytes.byteLength} bytes; the limit is ${FLEET_UPLOAD_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
  const uploadId = await uploads.start({
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.bytes.byteLength,
  });
  const { file: stored } = await uploads.append(uploadId, file.bytes);
  if (!stored) throw new Error(`upload of ${file.fileName} did not complete`);
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
        "Put a file (image, markdown, log, PDF, any type) into this daemon's upload store and get a fileId " +
        "back. Pass it as attachments: [{fileId}] to fleet_create_agent or fleet_send_prompt; the agent gets " +
        "the file's path, and images also arrive as native images. Agents on other hosts receive their own " +
        "copy. Small files: one call with fileName, mimeType and data (base64), or text for a text file. " +
        "Large files: send base64 chunks of up to a few MB; the first call also gives size (total bytes), " +
        `the next calls pass the returned uploadId. The file is stored once size bytes arrived. Max ${FLEET_UPLOAD_MAX_BYTES / 1024 / 1024} MB; ` +
        "an upload idle for 10 minutes is discarded.",
      inputSchema: {
        data: z
          .string()
          .optional()
          .describe(
            "Base64 bytes of this chunk (or of the whole file), no data: prefix. Give data or text.",
          ),
        text: z
          .string()
          .optional()
          .describe(
            "UTF-8 content of this chunk (or of the whole file), for text files such as markdown or logs. Give data or text.",
          ),
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
      data?: string;
      text?: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
      uploadId?: string;
    }) => {
      if ((input.data === undefined) === (input.text === undefined)) {
        return errorResult("Give exactly one of data (base64) or text (UTF-8)");
      }
      let bytes: Buffer;
      try {
        bytes =
          input.data !== undefined
            ? decodeBase64(input.data, "data")
            : Buffer.from(input.text ?? "", "utf8");
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
      if (file) {
        guidance =
          "Stored. Pass attachments: [{fileId}] to fleet_create_agent or fleet_send_prompt.";
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
