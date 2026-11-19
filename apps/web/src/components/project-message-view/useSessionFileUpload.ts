import { useState } from 'react';

import { useAttachments } from '../../pages/project-chat/useAttachments';

/** Stage files in R2; the message delivery worker transfers them after wake. */
export function useSessionFileUpload({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const attachments = useAttachments(projectId, setUploadError, sessionId);
  return {
    uploading: attachments.chatUploading,
    handleUploadFiles: attachments.handleChatFilesSelected,
    attachments: attachments.chatAttachments,
    removeAttachment: attachments.handleRemoveChatAttachment,
    clearAttachments: attachments.clearAttachments,
    uploadError,
  };
}
