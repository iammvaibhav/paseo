import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

/**
 * Wire delivery semantics for a submitted message. Mirrors the daemon's
 * SendMessageOptions.dispatchMode: "steer" rides along with the live turn
 * (native OMP steer, interrupt fallback), "queue" waits for idle, and absent
 * means interrupt (wire compat).
 */
export type MessageDispatchMode = "steer" | "interrupt" | "queue";

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
  dispatchMode?: MessageDispatchMode;
}
