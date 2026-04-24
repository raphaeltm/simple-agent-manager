import type {
  DirectoryEntry,
  FileMetadataResponse,
  ListFilesRequest,
  ListFilesResponse,
  MoveFileRequest,
  ProjectFile,
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
  if (filters?.directory) params.set('directory', filters.directory);
  if (filters?.recursive) params.set('recursive', 'true');
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
  /** Directory to upload into (default: '/') */
  directory?: string;
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
    if (options?.directory) formData.append('directory', options.directory);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/projects/${projectId}/library/upload`);
    xhr.withCredentials = true;
    xhr.timeout = 120_000; // 2 minutes

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
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));

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
    xhr.timeout = 120_000; // 2 minutes

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
    xhr.addEventListener('timeout', () => reject(new Error('Replace timed out')));

    xhr.send(formData);
  });
}

// =============================================================================
// Download file (triggers browser download)
// =============================================================================

export function downloadLibraryFile(projectId: string, fileId: string): void {
  const url = `${API_URL}/api/projects/${projectId}/library/${fileId}/download`;
  // Credentials are cookie-based — window.open carries cookies
  window.open(url, '_blank');
}

// =============================================================================
// Preview URL (inline rendering)
// =============================================================================

/** Returns the URL for inline file preview (images, PDFs). */
export function getLibraryFilePreviewUrl(projectId: string, fileId: string): string {
  return `${API_URL}/api/projects/${projectId}/library/${fileId}/preview`;
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

// =============================================================================
// List directories
// =============================================================================

export async function listLibraryDirectories(
  projectId: string,
  parentDirectory: string = '/',
  search?: string,
): Promise<{ directories: DirectoryEntry[] }> {
  const params = new URLSearchParams();
  if (parentDirectory !== '/') params.set('parentDirectory', parentDirectory);
  if (search) params.set('search', search);
  const qs = params.toString();
  return request<{ directories: DirectoryEntry[] }>(
    `/api/projects/${projectId}/library/directories${qs ? `?${qs}` : ''}`,
  );
}

// =============================================================================
// Move file
// =============================================================================

export async function moveLibraryFile(
  projectId: string,
  fileId: string,
  move: MoveFileRequest,
): Promise<ProjectFile> {
  return request<ProjectFile>(
    `/api/projects/${projectId}/library/${fileId}/move`,
    {
      method: 'PATCH',
      body: JSON.stringify(move),
    },
  );
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
