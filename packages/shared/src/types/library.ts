// =============================================================================
// Project File Library Types
// =============================================================================

/** Upload source — who uploaded the file */
export type FileUploadSource = 'user' | 'agent';

/** File status — lifecycle state */
export type FileStatus = 'uploading' | 'ready' | 'error';

/** Tag source — who created the tag */
export type FileTagSource = 'user' | 'agent';

// -----------------------------------------------------------------------------
// Core entities
// -----------------------------------------------------------------------------

export interface ProjectFile {
  id: string;
  projectId: string;
  filename: string;
  /** Directory path — always starts and ends with '/', root is '/' */
  directory: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  uploadedBy: string;
  uploadSource: FileUploadSource;
  uploadSessionId: string | null;
  uploadTaskId: string | null;
  replacedAt: string | null;
  replacedBy: string | null;
  status: FileStatus;
  extractedTextPreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFileTag {
  fileId: string;
  tag: string;
  tagSource: FileTagSource;
}

// -----------------------------------------------------------------------------
// Encryption metadata (stored alongside ciphertext in R2 custom metadata)
// -----------------------------------------------------------------------------

export interface FileEncryptionMetadata {
  /** Base64-encoded DEK wrapped by platform KEK */
  wrappedDek: string;
  /** Base64-encoded IV used for DEK wrapping */
  dekIv: string;
  /** Base64-encoded IV used for file data encryption */
  dataIv: string;
  /** Encryption algorithm identifier */
  algo: 'AES-256-GCM';
  /** KEK version identifier (for future key rotation) */
  keyVersion: string;
}

// -----------------------------------------------------------------------------
// Request / Response types
// -----------------------------------------------------------------------------

export interface CreateFileRequest {
  filename: string;
  description?: string;
  tags?: string[];
  uploadSource?: FileUploadSource;
  uploadSessionId?: string;
  uploadTaskId?: string;
}

export interface ReplaceFileRequest {
  description?: string;
}

export interface ListFilesRequest {
  /** Filter by tag (files must have ALL specified tags) */
  tags?: string[];
  /** Filter by MIME type prefix (e.g., 'image/', 'text/') */
  mimeType?: string;
  /** Filter by upload source */
  uploadSource?: FileUploadSource;
  /** Filter by status */
  status?: FileStatus;
  /** Search filename */
  search?: string;
  /** Filter by directory path (default: '/') */
  directory?: string;
  /** Include files in subdirectories (default: false) */
  recursive?: boolean;
  /** Sort field */
  sortBy?: 'filename' | 'createdAt' | 'updatedAt' | 'sizeBytes';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Pagination cursor (file ID) */
  cursor?: string;
  /** Page size */
  limit?: number;
}

export interface MoveFileRequest {
  /** New directory path (starts and ends with '/') */
  directory?: string;
  /** New filename */
  filename?: string;
}

export interface ListDirectoriesRequest {
  /** Parent directory to list subdirectories of (default: '/') */
  parentDirectory?: string;
}

export interface DirectoryEntry {
  /** Full path of this directory (e.g., '/marketing/brand/') */
  path: string;
  /** Display name (last segment, e.g., 'brand') */
  name: string;
  /** Number of files directly in this directory */
  fileCount: number;
}

export interface ListFilesResponse {
  files: (ProjectFile & { tags: ProjectFileTag[] })[];
  cursor: string | null;
  total: number;
}

export interface UpdateTagsRequest {
  add?: string[];
  remove?: string[];
}

export interface FileMetadataResponse {
  file: ProjectFile;
  tags: ProjectFileTag[];
}

// -----------------------------------------------------------------------------
// Configurable defaults (Constitution Principle XI — no hardcoded values)
// -----------------------------------------------------------------------------

export const LIBRARY_DEFAULTS = {
  /** Maximum file size per upload in bytes (default: 50MB). Env: LIBRARY_UPLOAD_MAX_BYTES */
  UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
  /** Maximum files per project (default: 500). Env: LIBRARY_MAX_FILES_PER_PROJECT */
  MAX_FILES_PER_PROJECT: 500,
  /** Maximum tags per file (default: 20). Env: LIBRARY_MAX_TAGS_PER_FILE */
  MAX_TAGS_PER_FILE: 20,
  /** Maximum tag length in characters (default: 50). Env: LIBRARY_MAX_TAG_LENGTH */
  MAX_TAG_LENGTH: 50,
  /** Maximum filename length in characters (default: 255). Env: LIBRARY_MAX_FILENAME_LENGTH */
  MAX_FILENAME_LENGTH: 255,
  /** Download timeout in milliseconds (default: 60000). Env: LIBRARY_DOWNLOAD_TIMEOUT_MS */
  DOWNLOAD_TIMEOUT_MS: 60_000,
  /** Default page size for list queries (default: 50). Env: LIBRARY_LIST_DEFAULT_PAGE_SIZE */
  LIST_DEFAULT_PAGE_SIZE: 50,
  /** Maximum page size for list queries (default: 200). Env: LIBRARY_LIST_MAX_PAGE_SIZE */
  LIST_MAX_PAGE_SIZE: 200,
  /** Maximum directory nesting depth (default: 10). Env: LIBRARY_MAX_DIRECTORY_DEPTH */
  MAX_DIRECTORY_DEPTH: 10,
  /** Maximum directory path length in chars (default: 500). Env: LIBRARY_MAX_DIRECTORY_PATH_LENGTH */
  MAX_DIRECTORY_PATH_LENGTH: 500,
  /** Maximum directories per project (default: 500). Env: LIBRARY_MAX_DIRECTORIES_PER_PROJECT */
  MAX_DIRECTORIES_PER_PROJECT: 500,
  /** Maximum file size for inline browser preview in bytes (default: 50MB). Env: FILE_PREVIEW_MAX_BYTES */
  FILE_PREVIEW_MAX_BYTES: 50 * 1024 * 1024,
  /** Maximum search query length in characters (default: 200). Env: LIBRARY_MAX_SEARCH_LENGTH */
  MAX_SEARCH_LENGTH: 200,
} as const;

/**
 * Allowed tag pattern: lowercase alphanumeric and hyphens, 1–50 chars.
 * Enforced at both API and shared level.
 */
export const LIBRARY_TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Allowed filename pattern: alphanumeric, dots, dashes, underscores, spaces.
 * Rejects shell metacharacters and path traversal.
 */
export const LIBRARY_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\- ]*$/;

/**
 * Allowed directory segment pattern: alphanumeric start, then alphanumeric/dots/hyphens/underscores/spaces.
 * Each segment of a directory path must match this pattern.
 */
export const LIBRARY_DIRECTORY_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\- ]*$/;

/**
 * Validate and normalize a directory path.
 * Returns the normalized path (always starts and ends with '/').
 * Throws if the path is invalid (traversal, bad chars, too deep, too long).
 *
 * @param path - Directory path to validate
 * @param maxDepth - Maximum nesting depth (default: LIBRARY_DEFAULTS.MAX_DIRECTORY_DEPTH)
 * @param maxLength - Maximum path length (default: LIBRARY_DEFAULTS.MAX_DIRECTORY_PATH_LENGTH)
 */
export function validateDirectoryPath(
  path: string,
  maxDepth: number = LIBRARY_DEFAULTS.MAX_DIRECTORY_DEPTH,
  maxLength: number = LIBRARY_DEFAULTS.MAX_DIRECTORY_PATH_LENGTH,
): string {
  // Reject null bytes
  if (path.includes('\0')) {
    throw new Error('Directory path contains null bytes');
  }

  // Normalize separators: backslash → forward slash, collapse multiples
  let normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');

  // Ensure leading slash
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  // Ensure trailing slash
  if (!normalized.endsWith('/')) normalized += '/';

  // Root is always valid
  if (normalized === '/') return '/';

  // Split into segments (filter empty from leading/trailing slashes)
  const segments = normalized.split('/').filter((s) => s.length > 0);

  // Reject traversal attempts
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error('Directory path cannot contain ".." or "." segments');
    }
  }

  // Validate each segment against allowed characters
  for (const seg of segments) {
    if (!LIBRARY_DIRECTORY_SEGMENT_PATTERN.test(seg)) {
      throw new Error(`Invalid directory segment: "${seg}"`);
    }
  }

  // Enforce depth limit
  if (segments.length > maxDepth) {
    throw new Error(`Directory depth ${segments.length} exceeds maximum of ${maxDepth}`);
  }

  // Enforce path length
  if (normalized.length > maxLength) {
    throw new Error(`Directory path length ${normalized.length} exceeds maximum of ${maxLength}`);
  }

  return normalized;
}

/**
 * Build the R2 object key for a library file.
 */
export function buildLibraryR2Key(projectId: string, fileId: string): string {
  return `library/${projectId}/${fileId}`;
}
