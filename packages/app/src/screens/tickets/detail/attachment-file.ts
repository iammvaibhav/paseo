import { File as FSFile, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { isWeb } from "@/constants/platform";
import type { TicketAttachmentContent } from "@/tickets/queries";

// String.fromCharCode takes its arguments on the stack, so large files go in chunks.
const BASE64_CHUNK_BYTES = 0x8000;

export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function safeFileName(fileName: string): string {
  const trimmed = fileName.trim();
  return trimmed ? trimmed.replace(/[\\/:*?"<>|]+/g, "_") : "attachment";
}

function downloadInBrowser(content: TicketAttachmentContent): void {
  const blob = new Blob([decodeBase64ToBytes(content.dataBase64)], { type: content.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(content.fileName);
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The click starts the download synchronously; the URL is not needed after it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function shareFromCache(content: TicketAttachmentContent): Promise<void> {
  const file = new FSFile(Paths.cache, safeFileName(content.fileName));
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(content.dataBase64, { encoding: "base64" });
  await Sharing.shareAsync(file.uri, {
    mimeType: content.mimeType,
    dialogTitle: content.fileName,
  });
}

/** Web and desktop download the file; iOS and Android open the share sheet. */
export async function openAttachmentFile(content: TicketAttachmentContent): Promise<void> {
  if (isWeb) {
    downloadInBrowser(content);
    return;
  }
  await shareFromCache(content);
}
