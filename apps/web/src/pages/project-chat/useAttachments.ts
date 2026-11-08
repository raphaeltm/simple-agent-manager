import { ATTACHMENT_DEFAULTS } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { TaskAttachmentRef } from '../../lib/api';
import { requestAttachmentUpload, uploadAttachmentToR2 } from '../../lib/api';
import { formatFileSize, withSafeFilename } from '../../lib/file-utils';

export const DEFAULT_ATTACHMENT_MESSAGE = 'Please read the attached files.';

export interface AttachmentUploadState {
  id: string;
  file: File;
  uploadId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
  ref?: TaskAttachmentRef;
}

export function useAttachments(
  projectId: string,
  setSubmitError: (e: string | null) => void,
  scopeId = projectId
) {
  const [chatAttachments, setState] = useState<AttachmentUploadState[]>([]);
  const queueRef = useRef<AttachmentUploadState[]>([]);
  const setChatAttachments = useCallback(
    (
      update:
        AttachmentUploadState[] | ((previous: AttachmentUploadState[]) => AttachmentUploadState[])
    ) => {
      queueRef.current = typeof update === 'function' ? update(queueRef.current) : update;
      setState(queueRef.current);
    },
    []
  );
  useEffect(() => {
    setChatAttachments([]);
    setSubmitError(null);
  }, [projectId, scopeId, setChatAttachments, setSubmitError]);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const chatUploading = chatAttachments.some(
    (a) => a.status === 'uploading' || a.status === 'pending'
  );

  const handleChatFileUpload = useCallback(
    async (file: File, id: string) => {
      try {
        const presigned = await requestAttachmentUpload(
          projectId,
          file.name,
          file.size,
          file.type || 'application/octet-stream'
        );
        setChatAttachments((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, uploadId: presigned.uploadId, status: 'uploading' as const } : a
          )
        );
        await uploadAttachmentToR2(presigned.uploadUrl, file, (loaded, total) => {
          const progress = Math.round((loaded / total) * 100);
          setChatAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, progress } : a)));
        });
        const ref: TaskAttachmentRef = {
          uploadId: presigned.uploadId,
          filename: file.name,
          size: file.size,
          contentType: file.type || 'application/octet-stream',
        };
        setChatAttachments((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, status: 'complete' as const, progress: 100, ref } : a
          )
        );
      } catch (err) {
        setChatAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  ...a,
                  status: 'error' as const,
                  error: err instanceof Error ? err.message : 'Upload failed',
                }
              : a
          )
        );
      }
    },
    [projectId, setChatAttachments]
  );

  const handleChatFilesSelected = useCallback(
    (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      setSubmitError(null);
      const current = queueRef.current;
      const maxFiles = ATTACHMENT_DEFAULTS.MAX_FILES;
      const maxBytes = ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES;
      const batchMax = ATTACHMENT_DEFAULTS.UPLOAD_BATCH_MAX_BYTES;
      const newFiles: AttachmentUploadState[] = [];
      const currentTotal = current.reduce(
        (sum, a) => (a.status === 'error' ? sum : sum + a.file.size),
        0
      );
      let runningTotal = currentTotal;
      for (const file of Array.from(files).map(withSafeFilename)) {
        if (current.length + newFiles.length >= maxFiles) {
          setSubmitError(`Maximum ${maxFiles} files allowed`);
          break;
        }
        // An empty or over-limit file is staged as failed instead of dropped, so the person can
        // open it from the local copy, see which file it was, and remove it. It is never uploaded,
        // and a failed attachment already blocks sending.
        const rejection =
          file.size === 0
            ? 'This file is empty'
            : file.size > maxBytes
              ? `Larger than the ${formatFileSize(maxBytes)} limit`
              : null;
        if (rejection) {
          newFiles.push({
            id: crypto.randomUUID(),
            file,
            uploadId: null,
            progress: 0,
            status: 'error',
            error: rejection,
          });
          continue;
        }
        if (runningTotal + file.size > batchMax) {
          setSubmitError(`Total size would exceed ${formatFileSize(batchMax)} limit`);
          break;
        }
        runningTotal += file.size;
        newFiles.push({
          id: crypto.randomUUID(),
          file,
          uploadId: null,
          progress: 0,
          status: 'pending',
        });
      }
      if (newFiles.length === 0) return;
      setChatAttachments((prev) => [...prev, ...newFiles]);
      for (const newFile of newFiles) {
        if (newFile.status === 'pending') void handleChatFileUpload(newFile.file, newFile.id);
      }
    },
    [handleChatFileUpload, setSubmitError, setChatAttachments]
  );

  const handleRemoveChatAttachment = useCallback(
    (index: number) => {
      setChatAttachments((prev) => prev.filter((_, i) => i !== index));
    },
    [setChatAttachments]
  );

  const clearAttachments = useCallback(() => {
    setChatAttachments([]);
    if (chatFileInputRef.current) chatFileInputRef.current.value = '';
    setSubmitError(null);
  }, [setChatAttachments, setSubmitError]);

  return {
    chatAttachments,
    chatFileInputRef,
    chatUploading,
    handleChatFilesSelected,
    handleRemoveChatAttachment,
    clearAttachments,
  };
}
