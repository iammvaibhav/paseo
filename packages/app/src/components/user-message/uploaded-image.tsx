import { useCallback } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { persistAttachmentFromBytes } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { isRasterImageMimeType } from "@/attachments/file-types";
import { createPreviewAttachmentId } from "@/attachments/utils";
import {
  AttachmentFrame,
  AttachmentThumbnail,
  AttachmentUnavailableThumbnail,
} from "@/components/attachment-pill";
import { useFetchQuery } from "@/data/query";

export type UploadedFileAttachment = Extract<AgentAttachment, { type: "uploaded_file" }>;

/** An uploaded file the message shows as a thumbnail instead of a file chip. */
export function isUploadedImageAttachment(
  attachment: AgentAttachment,
): attachment is UploadedFileAttachment {
  return attachment.type === "uploaded_file" && isRasterImageMimeType(attachment.mimeType);
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

/**
 * An image sent as an uploaded file (fleet tools attach screenshots this way). The bytes live
 * in the upload store of the agent's host, so the thumbnail reads them through that host's
 * file RPC and caches them like any other preview attachment.
 */
export function UploadedImagePill({
  attachment,
  client,
  serverId,
  onOpen,
  accessibilityLabel,
}: {
  attachment: UploadedFileAttachment;
  client: Pick<DaemonClient, "readFile"> | null | undefined;
  serverId: string | undefined;
  onOpen: (image: AttachmentMetadata) => void;
  accessibilityLabel: string;
}) {
  const { t } = useTranslation();
  const query = useFetchQuery({
    queryKey: ["userMessageUploadedImage", serverId ?? null, attachment.id, attachment.path],
    enabled: client != null,
    dataShape: "value",
    immutableWhen: () => true,
    queryFn: async () => {
      if (!client) throw new Error("Host not connected");
      const file = await client.readFile(parentDirectory(attachment.path), attachment.path);
      if (file.kind !== "image") throw new Error("Uploaded file is not an image");
      return await persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType: attachment.mimeType,
          path: attachment.path,
          size: attachment.size,
          contentLength: file.bytes.byteLength,
          contentKey: `${serverId ?? "unknown-server"}:${attachment.id}`,
        }),
        bytes: file.bytes,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      });
    },
  });
  const persisted = query.data ?? null;
  const handlePress = useCallback(() => {
    if (persisted) onOpen(persisted);
  }, [onOpen, persisted]);
  if (query.isError) {
    return (
      <AttachmentFrame testID="user-message-image-unavailable">
        <AttachmentUnavailableThumbnail
          accessibilityLabel={t("composer.attachments.imageUnavailable")}
        />
      </AttachmentFrame>
    );
  }
  return (
    <AttachmentFrame
      onPress={handlePress}
      accessibilityLabel={accessibilityLabel}
      testID="user-message-uploaded-image"
    >
      {persisted ? <AttachmentThumbnail metadata={persisted} /> : <View />}
    </AttachmentFrame>
  );
}
