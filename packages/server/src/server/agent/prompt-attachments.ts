import { getForgeDefinitionOrNeutral } from "@getpaseo/protocol/forge-manifest";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { writeStoredUpload } from "../file-upload/index.js";
import type { AgentPromptContentBlock, AgentPromptInput } from "./agent-sdk-types.js";

type UploadedFileAttachment = Extract<AgentAttachment, { type: "uploaded_file" }>;

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

export function buildAgentPrompt(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  attachments?: AgentAttachment[],
): AgentPromptInput {
  const normalized = text.trim();
  const hasImages = (images?.length ?? 0) > 0;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!hasImages && !hasAttachments) {
    return normalized;
  }

  const chatHistoryAttachments: AgentAttachment[] = [];
  const otherAttachments: AgentAttachment[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.type === "text" && attachment.contextKind === "chat_history") {
      chatHistoryAttachments.push(attachment);
    } else {
      otherAttachments.push(attachment);
    }
  }

  const blocks: AgentPromptContentBlock[] = [...chatHistoryAttachments];
  if (normalized.length > 0) {
    blocks.push({ type: "text", text: normalized });
  }
  for (const image of images ?? []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  blocks.push(...otherAttachments);
  return blocks;
}

/**
 * Whether a native image is the inline copy of an uploaded_file attachment in
 * the same prompt. Fleet tools and storePromptImages send an image both ways:
 * the native block for the model, the attachment for its path.
 */
export function isUploadedFileCopy(
  image: { data: string; mimeType: string },
  uploads: readonly UploadedFileAttachment[],
): boolean {
  return uploads.some(
    (upload) =>
      upload.mimeType === image.mimeType && Buffer.byteLength(image.data, "base64") === upload.size,
  );
}

function imageFileExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(/[+;]/)[0]?.trim().toLowerCase() ?? "";
  if (subtype === "jpeg") return "jpg";
  return /^[a-z0-9.-]+$/.test(subtype) ? subtype : "bin";
}

/**
 * Saves each inline prompt image that has no uploaded_file copy yet into the
 * upload store and returns the attachments with those copies appended. The
 * model still gets the native image; the attachment tells the agent the
 * file's path so it can hand the image on (fleet_send_prompt attachments,
 * WhatsApp media). Without a paseoHome the attachments pass through.
 */
export async function storePromptImages(
  paseoHome: string | undefined,
  images: ReadonlyArray<{ data: string; mimeType: string }> | undefined,
  attachments: AgentAttachment[] | undefined,
): Promise<AgentAttachment[] | undefined> {
  if (!paseoHome || !images || images.length === 0) return attachments;
  const uploads = (attachments ?? []).filter(
    (attachment): attachment is UploadedFileAttachment => attachment.type === "uploaded_file",
  );
  const stored: AgentAttachment[] = [];
  // Sequential: each image is written to disk in turn.
  for (const [index, image] of images.entries()) {
    if (isUploadedFileCopy(image, uploads)) continue;
    stored.push(
      await writeStoredUpload(paseoHome, {
        fileName: `image-${index + 1}.${imageFileExtension(image.mimeType)}`,
        mimeType: image.mimeType,
        bytes: Buffer.from(image.data, "base64"),
      }),
    );
  }
  return stored.length > 0 ? [...(attachments ?? []), ...stored] : attachments;
}

export function renderPromptAttachmentAsText(attachment: AgentAttachment): string {
  switch (attachment.type) {
    case "forge_change_request": {
      return renderChangeRequestAttachment({
        forge: attachment.forge,
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        projectPath: attachment.projectPath,
        baseRefName: attachment.baseRefName,
        headRefName: attachment.headRefName,
      });
    }
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_pr": {
      return renderChangeRequestAttachment({
        forge: "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        baseRefName: attachment.baseRefName,
        headRefName: attachment.headRefName,
      });
    }
    case "forge_issue": {
      return renderIssueAttachment({
        forge: attachment.forge,
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        projectPath: attachment.projectPath,
      });
    }
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_issue": {
      return renderIssueAttachment({
        forge: "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
      });
    }
    case "text": {
      return attachment.text;
    }
    case "review": {
      const lines = [`Paseo review attachment (${attachment.mode})`, `CWD: ${attachment.cwd}`];
      if (attachment.baseRef) {
        lines.push(`Base: ${attachment.baseRef}`);
      }
      attachment.comments.forEach((comment, index) => {
        lines.push(
          "",
          `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
          comment.body,
          comment.context.hunkHeader,
        );
        const target = comment.context.targetLine;
        for (const line of comment.context.lines) {
          const isTarget =
            line.oldLineNumber === target.oldLineNumber &&
            line.newLineNumber === target.newLineNumber &&
            line.type === target.type &&
            line.content === target.content;
          const prefix = isTarget ? "> " : "  ";
          const oldLn = padLineNumber(line.oldLineNumber);
          const newLn = padLineNumber(line.newLineNumber);
          lines.push(`${prefix}${oldLn} ${newLn} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`);
        }
      });
      return lines.join("\n");
    }
    case "uploaded_file": {
      return [
        `Uploaded file: ${attachment.fileName}`,
        `fileId: ${attachment.id}`,
        `Path: ${attachment.path}`,
        `MIME: ${attachment.mimeType}`,
        `Size: ${attachment.size} bytes`,
      ].join("\n");
    }
    default:
      throw new Error("unreachable");
  }
}

function renderChangeRequestAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} ${formatChangeRequestAbbrev(input.forge)} ${formatChangeRequestNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.baseRefName) {
    lines.push(`Base: ${input.baseRefName}`);
  }
  if (input.headRefName) {
    lines.push(`Head: ${input.headRefName}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function renderIssueAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} Issue ${formatIssueNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function formatForgeLabel(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).displayName;
}

function formatChangeRequestAbbrev(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).changeRequestAbbrev;
}

function formatChangeRequestNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).changeRequestNumberPrefix}${number}`;
}

function formatIssueNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).issueNumberPrefix}${number}`;
}

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

export function buildAgentBranchNameSeed(
  firstAgentContext: { prompt?: string; attachments?: readonly AgentAttachment[] } | undefined,
): string | undefined {
  if (!firstAgentContext) {
    return undefined;
  }
  const parts: string[] = [];
  const prompt = firstAgentContext.prompt?.trim();
  if (prompt) {
    parts.push(["<user-prompt>", prompt, "</user-prompt>"].join("\n"));
  }
  const renderedAttachments: string[] = [];
  for (const attachment of firstAgentContext.attachments ?? []) {
    const rendered = renderPromptAttachmentAsText(attachment).trim();
    if (rendered) {
      renderedAttachments.push(rendered);
    }
  }
  if (renderedAttachments.length > 0) {
    parts.push(["<attachments>", renderedAttachments.join("\n\n"), "</attachments>"].join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
