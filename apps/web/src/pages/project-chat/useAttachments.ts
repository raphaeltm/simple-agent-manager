import { ATTACHMENT_DEFAULTS, SAFE_FILENAME_REGEX } from '@simple-agent-manager/shared';
import { useCallback, useRef, useState } from 'react';

import type { TaskAttachmentRef } from '../../lib/api';
import { requestAttachmentUpload, uploadAttachmentToR2 } from '../../lib/api';
import { formatFileSize } from '../../lib/file-utils';

export interface AttachmentUploadState {
  file: File;
  uploadId: string | null;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
  ref?: TaskAttachmentRef;
}

export function useAttachments(projectId: string, setSubmitError: (e: string | null) => void) {
  const [chatAttachments, setChatAttachments] = useState<AttachmentUploadState[]>([]);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const chatUploading = chatAttachments.some((a) => a.status === 'uploading' || a.status === 'pending');

  const handleChatFileUpload = useCallback(async (file: File, index: number) => {
    try {
      const presigned = await requestAttachmentUpload(
        projectId, file.name, file.size, file.type || 'application/octet-stream',
      );
      setChatAttachments((prev) =>
        prev.map((a, i) => i === index ? { ...a, uploadId: presigned.uploadId, status: 'uploading' as const } : a),
      );
      await uploadAttachmentToR2(presigned.uploadUrl, file, (loaded, total) => {
        const progress = Math.round((loaded / total) * 100);
        setChatAttachments((prev) => prev.map((a, i) => i === index ? { ...a, progress } : a));
      });
      const ref: TaskAttachmentRef = {
        uploadId: presigned.uploadId, filename: file.name,
        size: file.size, contentType: file.type || 'application/octet-stream',
      };
      setChatAttachments((prev) =>
        prev.map((a, i) => i === index ? { ...a, status: 'complete' as const, progress: 100, ref } : a),
      );
    } catch (err) {
      setChatAttachments((prev) =>
        prev.map((a, i) => i === index ? { ...a, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' } : a),
      );
    }
  }, [projectId]);

  const handleChatFilesSelected = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const maxFiles = ATTACHMENT_DEFAULTS.MAX_FILES;
    const maxBytes = ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES;
    const batchMax = ATTACHMENT_DEFAULTS.UPLOAD_BATCH_MAX_BYTES;
    const newFiles: AttachmentUploadState[] = [];
    const currentTotal = chatAttachments.reduce((sum, a) => sum + a.file.size, 0);
    let runningTotal = currentTotal;
    for (const file of Array.from(files)) {
      if (chatAttachments.length + newFiles.length >= maxFiles) {
        setSubmitError(`Maximum ${maxFiles} files allowed`);
        break;
      }
      if (file.size > maxBytes) {
        setSubmitError(`${file.name} exceeds ${formatFileSize(maxBytes)} limit`);
        continue;
      }
      if (!SAFE_FILENAME_REGEX.test(file.name)) {
        setSubmitError(`${file.name} has invalid characters`);
        continue;
      }
      if (runningTotal + file.size > batchMax) {
        setSubmitError(`Total size would exceed ${formatFileSize(batchMax)} limit`);
        break;
      }
      runningTotal += file.size;
      newFiles.push({ file, uploadId: null, progress: 0, status: 'pending' });
    }
    if (newFiles.length === 0) return;
    const startIndex = chatAttachments.length;
    setChatAttachments((prev) => [...prev, ...newFiles]);
    for (let i = 0; i < newFiles.length; i++) { void handleChatFileUpload(newFiles[i]!.file, startIndex + i); }
  }, [chatAttachments, handleChatFileUpload, setSubmitError]);

  const handleRemoveChatAttachment = useCallback((index: number) => {
    setChatAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachments = useCallback(() => {
    setChatAttachments([]);
    if (chatFileInputRef.current) chatFileInputRef.current.value = '';
  }, []);

  return {
    chatAttachments,
    chatFileInputRef,
    chatUploading,
    handleChatFilesSelected,
    handleRemoveChatAttachment,
    clearAttachments,
  };
}
