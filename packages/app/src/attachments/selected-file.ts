import { getFileExtension } from "@/attachments/file-types";
import { copyDesktopAttachmentFile } from "@/desktop/attachments/desktop-file-commands";
import { readDesktopFileBase64 } from "@/desktop/attachments/desktop-preview-url";
import { decodeBase64OrThrow } from "@/utils/base64";

export interface SelectedFile {
  fileName: string;
  mimeType: string;
  readBytes(): Promise<Uint8Array>;
}

export async function readDesktopFileBytes(path: string): Promise<Uint8Array> {
  const { path: managedPath } = await copyDesktopAttachmentFile({
    attachmentId: crypto.randomUUID(),
    sourcePath: path,
    extension: getFileExtension(path) || null,
  });
  const base64 = await readDesktopFileBase64(managedPath);
  return decodeBase64OrThrow(base64, `Desktop file ${path}`);
}
