import type { ItsaplanAttachment, ItsaplanClient } from "./client.js";

/** Native image payload, same shape as composer paste / create_agent images. */
export interface TicketNativeImage {
  data: string;
  mimeType: string;
}

/** Non-image ticket files stay as download links in the prompt. */
export interface TicketFileLink {
  filename: string;
  url: string;
}

export interface ResolvedTicketAttachments {
  images: TicketNativeImage[];
  files: TicketFileLink[];
}

const RASTER_IMAGE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|bmp))$/;

/** Skip huge files so a ticket dump cannot blow the model context. */
export const MAX_TICKET_IMAGE_BYTES = 8 * 1024 * 1024;

export function isRasterImageContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return RASTER_IMAGE_MIME.test(mime);
}

export function resolveAttachmentUrl(url: string, baseUrl: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  const baseUrlClean = baseUrl.replace(/\/+$/, "");
  return `${baseUrlClean}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** Markdown image / link whose href is a ticket attachment path. */
const MARKDOWN_ATTACHMENT_RE = /!?\[([^\]]*)\]\((\/(?:media\/)?attachments\/[^)\s]+)\)/g;

/**
 * itsaplan's composer writes `/media/attachments/<id>/raw`. The public raw
 * route is `/attachments/<id>/raw` — `/media/` 404s. Rewrite so a leftover
 * markdown link is actually fetchable.
 */
export function rewriteMarkdownAttachmentUrls(text: string): string {
  return text.replace(MARKDOWN_ATTACHMENT_RE, (_match, label: string, href: string) => {
    const rewritten = href.replace(/^\/media\/attachments\//, "/attachments/");
    const prefix = _match.startsWith("!") ? "!" : "";
    return `${prefix}[${label}](${rewritten})`;
  });
}

/**
 * Drop markdown image embeds that we already attached natively so Commander
 * does not fetch a (often 404) URL instead of using the native payload.
 */
export function stripNativeMarkdownImages(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\((\/(?:media\/)?attachments\/[^)\s]+)\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split ticket attachments into native raster images (base64) and file links.
 * Image download failures drop that image to a file link so dispatch still
 * proceeds. Non-raster files (pdf, svg, logs) stay as links.
 */
export async function resolveTicketAttachments(
  client: ItsaplanClient,
  issueId: number,
  baseUrl: string,
): Promise<ResolvedTicketAttachments> {
  const listed = await client.listIssueAttachments(issueId).catch(() => [] as ItsaplanAttachment[]);
  const images: TicketNativeImage[] = [];
  const files: TicketFileLink[] = [];

  for (const attachment of listed) {
    const url = resolveAttachmentUrl(attachment.url, baseUrl);
    const fileLink = { filename: attachment.filename, url };
    if (!isRasterImageContentType(attachment.contentType)) {
      files.push(fileLink);
      continue;
    }
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes > MAX_TICKET_IMAGE_BYTES) {
      files.push(fileLink);
      continue;
    }
    try {
      const downloaded = await client.downloadAttachment(url);
      if (downloaded.bytes.length > MAX_TICKET_IMAGE_BYTES) {
        files.push(fileLink);
        continue;
      }
      const mime =
        (downloaded.contentType ?? attachment.contentType)?.split(";")[0]?.trim().toLowerCase() ??
        "image/png";
      images.push({
        data: downloaded.bytes.toString("base64"),
        mimeType: mime.length > 0 ? mime : "image/png",
      });
    } catch {
      files.push(fileLink);
    }
  }

  return { images, files };
}
