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
  /** File IDs per tag lookup query (default: 80). Env: LIBRARY_TAG_QUERY_BATCH_SIZE */
  TAG_QUERY_BATCH_SIZE: 80,
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
  /**
   * Maximum file count for which the web client sweeps the entire library into
   * a client-side index for instant ranked search (default: 300). At or above
   * this count the client falls back to the server-search path. The web app may
   * override this via VITE_LIBRARY_CLIENT_SWEEP_CAP.
   */
  CLIENT_SWEEP_CAP: 300,
  /**
   * Safety cap on client sweep iterations (default: 10). At LIST_MAX_PAGE_SIZE
   * (200) this covers 2000 files — far above CLIENT_SWEEP_CAP — so it only ever
   * fires as a runaway guard. The web app may override via
   * VITE_LIBRARY_CLIENT_MAX_SWEEP_PAGES.
   */
  CLIENT_MAX_SWEEP_PAGES: 10,
  /**
   * Client-side library cache TTL in milliseconds (default: 5 minutes). The web
   * app may override via VITE_LIBRARY_CACHE_TTL_MS.
   */
  CLIENT_CACHE_TTL_MS: 5 * 60 * 1000,
  /**
   * Maximum LRU evictions attempted on a localStorage quota error before giving
   * up on a cache write (default: 5). The web app may override via
   * VITE_LIBRARY_CACHE_MAX_EVICTIONS.
   */
  CLIENT_CACHE_MAX_EVICTIONS: 5,
  /**
   * Debounce delay in milliseconds for the always-visible library search input
   * (default: 300). The web app may override via VITE_LIBRARY_SEARCH_DEBOUNCE_MS.
   */
  CLIENT_SEARCH_DEBOUNCE_MS: 300,
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

// -----------------------------------------------------------------------------
// MIME type resolution (shared by web preview predicates + API preview route)
// -----------------------------------------------------------------------------

/**
 * Strip MIME parameters (e.g. "; charset=utf-8") and return the base type,
 * trimmed and lowercased.
 */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase();
}

/**
 * Whether a stored MIME type is "unknown" and should trigger extension-based
 * resolution. Agent uploads that hit the vm-agent's host-MIME-DB fallback land
 * as `application/octet-stream`; some legacy rows are empty.
 */
export function isUnknownMimeType(mimeType: string | null | undefined): boolean {
  const base = baseMimeType(mimeType ?? '');
  return base === '' || base === 'application/octet-stream';
}

/**
 * Canonical filename-extension → MIME map for preview/serve decisions.
 *
 * Mirrors the vm-agent's curated map (packages/vm-agent/internal/server/mimetype.go)
 * plus the image/PDF/HTML types the library preview understands. This is the
 * defense-in-depth + backfill layer: it makes already-stored octet-stream files
 * (uploaded before the vm-agent fix) previewable without a re-upload, and
 * guards against any future host-MIME-DB divergence.
 *
 * A curated static type table is not a Constitution Principle XI hardcoded
 * configuration value. See .claude/rules/51-vm-agent-no-host-mime-db.md.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // text / document
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/**
 * Resolve a MIME type from a filename's extension. Returns '' when the filename
 * has no extension or the extension is not in the curated map.
 */
export function mimeTypeFromFilename(filename: string | null | undefined): string {
  if (!filename) return '';
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  // No dot, or a leading-dot dotfile with no further extension (e.g. ".env"):
  // treat as having no usable extension.
  if (dot <= 0) return '';
  const ext = lower.slice(dot + 1);
  return EXTENSION_TO_MIME[ext] ?? '';
}

/**
 * Resolve the effective MIME type for a stored file: use the stored MIME
 * unless it is unknown/`application/octet-stream`, in which case fall back to
 * the filename extension. Returns the base (parameter-stripped, lowercased)
 * type. When the stored MIME is unknown AND the extension is unrecognized, the
 * unknown base is returned unchanged (so callers still fail their preview gate).
 *
 * SECURITY: an extension-derived `text/html` / `image/svg+xml` returned here
 * carries no special trust — callers MUST route it through the SAME
 * neutralization/sandboxing as a stored `text/html` / `image/svg+xml` (the API
 * preview route serves HTML as text/plain with a strict CSP and never lists
 * SVG as previewable). Never serve a sniffed type unsandboxed.
 */
export function resolveEffectiveMimeType(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): string {
  const base = baseMimeType(mimeType ?? '');
  if (!isUnknownMimeType(base)) return base;
  const fromExt = mimeTypeFromFilename(filename);
  return fromExt || base;
}
