/**
 * Session file upload with an optimistic transcript entry.
 *
 * Extracted from `useSessionLifecycle` to keep that file under the 800-line hard
 * ceiling (rule 18). This is a genuinely separable concern: it depends only on the
 * session identity and the message-cache writer, and touches none of the
 * activity/wake/socket state the rest of the hook coordinates.
 */

import { useCallback, useState } from 'react';

import type { ChatMessageResponse } from '../../lib/api';
import { uploadSessionFiles } from '../../lib/api';

export interface UseSessionFileUploadArgs {
  projectId: string;
  sessionId: string;
  onOptimisticMessage: (message: ChatMessageResponse) => void;
}

export interface UseSessionFileUploadReturn {
  uploading: boolean;
  handleUploadFiles: (files: FileList | File[]) => Promise<void>;
}

export function useSessionFileUpload({
  projectId,
  sessionId,
  onOptimisticMessage,
}: UseSessionFileUploadArgs): UseSessionFileUploadReturn {
  const [uploading, setUploading] = useState(false);

  const handleUploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;
      setUploading(true);
      try {
        const result = await uploadSessionFiles(projectId, sessionId, fileArray);
        const names = result.files.map((f) => f.name).join(', ');
        onOptimisticMessage({
          id: `optimistic-upload-${crypto.randomUUID()}`,
          sessionId,
          role: 'user' as const,
          content: `Uploaded ${result.files.length} file${result.files.length > 1 ? 's' : ''}: ${names}`,
          toolMetadata: null,
          createdAt: Date.now(),
        });
      } catch (err) {
        console.error('File upload failed:', err);
      } finally {
        setUploading(false);
      }
    },
    [onOptimisticMessage, projectId, sessionId]
  );

  return { uploading, handleUploadFiles };
}
