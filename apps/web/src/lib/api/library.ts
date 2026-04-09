import type {
  FileMetadataResponse,
  ListFilesRequest,
  ListFilesResponse,
  ProjectFileTag,
  UpdateTagsRequest,
} from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

// =============================================================================
// List files
// =============================================================================

export async function listLibraryFiles(
  projectId: string,
  filters?: ListFilesRequest,
): Promise<ListFilesResponse> {
  const params = new URLSearchParams();
  if (filters?.tags?.length) params.set('tags', filters.tags.join(','));
  if (filters?.mimeType) params.set('mimeType', filters.mimeType);
  if (filters?.uploadSource) params.set('uploadSource', filters.uploadSource);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.sortBy) params.set('sortBy', filters.sortBy);
  if (filters?.sortOrder) params.set('sortOrder', filters.sortOrder);
  if (filters?.cursor) params.set('cursor', filters.cursor);
  if (filters?.limit) params.set('limit', String(filters.limit));

  const qs = params.toString();
  const endpoint = `/api/projects/${projectId}/library${qs ? `?${qs}` : ''}`;
  return request<ListFilesResponse>(endpoint);
}

// =============================================================================
// Get file metadata
// =============================================================================

export async function getLibraryFile(
  projectId: string,
  fileId: string,
): Promise<FileMetadataResponse> {
  return request<FileMetadataResponse>(`/api/projects/${projectId}/library/${fileId}`);
}

// =============================================================================
// Upload file (multipart)
// =============================================================================

export interface UploadLibraryFileOptions {
  description?: string;
  tags?: string[];
  onProgress?: (loaded: number, total: number) => void;
}

export function uploadLibraryFile(
  projectId: string,
  file: File,
  options?: UploadLibraryFileOptions,
): Promise<FileMetadataResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('filename', file.name);
    formData.append('mimeType', file.type || 'application/octet-stream');
    if (options?.description) formData.append('description', options.description);
    if (options?.tags?.length) formData.append('tags', options.tags.join(','));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/projects/${projectId}/library/upload`);
    xhr.withCredentials = true;

    const progressCb = options?.onProgress;
    if (progressCb) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          progressCb(e.loaded, e.total);
        }
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText) as Record<string, unknown>;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as unknown as FileMetadataResponse);
        } else {
          reject(new Error((data.message as string) || `Upload failed with status ${xhr.status}`));
        }
      } catch {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Upload network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    xhr.send(formData);
  });
}

// =============================================================================
// Replace file (multipart)
// =============================================================================

export function replaceLibraryFile(
  projectId: string,
  fileId: string,
  file: File,
  options?: { description?: string; onProgress?: (loaded: number, total: number) => void },
): Promise<FileMetadataResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('filename', file.name);
    formData.append('mimeType', file.type || 'application/octet-stream');
    if (options?.description) formData.append('description', options.description);

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_URL}/api/projects/${projectId}/library/${fileId}/replace`);
    xhr.withCredentials = true;

    const progressCb = options?.onProgress;
    if (progressCb) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          progressCb(e.loaded, e.total);
        }
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText) as Record<string, unknown>;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as unknown as FileMetadataResponse);
        } else {
          reject(new Error((data.message as string) || `Replace failed with status ${xhr.status}`));
        }
      } catch {
        reject(new Error(`Replace failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Replace network error')));
    xhr.addEventListener('abort', () => reject(new Error('Replace aborted')));

    xhr.send(formData);
  });
}

// =============================================================================
// Download file (triggers browser download)
// =============================================================================

export function downloadLibraryFile(projectId: string, fileId: string): void {
  const url = `${API_URL}/api/projects/${projectId}/library/${fileId}/download`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  // Credentials are cookie-based so we need a form/fetch approach for auth
  // Use a hidden iframe or window.open for cookie-based auth downloads
  window.open(url, '_blank');
}

// =============================================================================
// Delete file
// =============================================================================

export async function deleteLibraryFile(
  projectId: string,
  fileId: string,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/projects/${projectId}/library/${fileId}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// Update tags
// =============================================================================

export async function updateFileTags(
  projectId: string,
  fileId: string,
  tagsUpdate: UpdateTagsRequest,
): Promise<{ tags: ProjectFileTag[] }> {
  return request<{ tags: ProjectFileTag[] }>(
    `/api/projects/${projectId}/library/${fileId}/tags`,
    {
      method: 'POST',
      body: JSON.stringify(tagsUpdate),
    },
  );
}
