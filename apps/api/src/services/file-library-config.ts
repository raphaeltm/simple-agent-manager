/**
 * File Library configuration helpers and validation functions.
 *
 * All limits are configurable per constitution Principle XI.
 */

import {
  LIBRARY_DEFAULTS,
  LIBRARY_FILENAME_PATTERN,
  LIBRARY_TAG_PATTERN,
  validateDirectoryPath,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { errors } from '../middleware/error';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function getUploadMaxBytes(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_UPLOAD_MAX_BYTES, LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES);
}

export function getMaxFilesPerProject(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_FILES_PER_PROJECT, LIBRARY_DEFAULTS.MAX_FILES_PER_PROJECT);
}

export function getMaxTagsPerFile(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_TAGS_PER_FILE, LIBRARY_DEFAULTS.MAX_TAGS_PER_FILE);
}

export function getMaxTagLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_TAG_LENGTH, LIBRARY_DEFAULTS.MAX_TAG_LENGTH);
}

export function getMaxFilenameLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_FILENAME_LENGTH, LIBRARY_DEFAULTS.MAX_FILENAME_LENGTH);
}

export function getDownloadTimeoutMs(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_DOWNLOAD_TIMEOUT_MS, LIBRARY_DEFAULTS.DOWNLOAD_TIMEOUT_MS);
}

export function getKeyVersion(env: Env): string {
  return env.LIBRARY_KEY_VERSION ?? '1';
}

function getListDefaultPageSize(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_LIST_DEFAULT_PAGE_SIZE, LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE);
}

export function getListMaxPageSize(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_LIST_MAX_PAGE_SIZE, LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE);
}

export function getMaxDirectoryDepth(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_DIRECTORY_DEPTH, LIBRARY_DEFAULTS.MAX_DIRECTORY_DEPTH);
}

export function getMaxDirectoryPathLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_DIRECTORY_PATH_LENGTH, LIBRARY_DEFAULTS.MAX_DIRECTORY_PATH_LENGTH);
}

export function getMaxDirectoriesPerProject(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_DIRECTORIES_PER_PROJECT, LIBRARY_DEFAULTS.MAX_DIRECTORIES_PER_PROJECT);
}

export function getMaxSearchLength(env: Env): number {
  return parseIntOrDefault(env.LIBRARY_MAX_SEARCH_LENGTH, LIBRARY_DEFAULTS.MAX_SEARCH_LENGTH);
}

/** Validate a directory path using configurable env limits. Throws on invalid. Returns normalized path. */
export function validateDirectory(directory: string, env: Env): string {
  return validateDirectoryPath(directory, getMaxDirectoryDepth(env), getMaxDirectoryPathLength(env));
}

// ---------------------------------------------------------------------------
// Tag validation
// ---------------------------------------------------------------------------

export function validateTag(tag: string, env: Env): void {
  const maxLen = getMaxTagLength(env);
  if (tag.length === 0 || tag.length > maxLen) {
    throw errors.badRequest(`Tag must be 1-${maxLen} characters`);
  }
  if (!LIBRARY_TAG_PATTERN.test(tag)) {
    throw errors.badRequest(`Tag "${tag}" must be lowercase alphanumeric with hyphens`);
  }
}

export function validateFilename(filename: string, env: Env): void {
  const maxLen = getMaxFilenameLength(env);
  if (!filename || filename.length > maxLen) {
    throw errors.badRequest(`Filename must be 1-${maxLen} characters`);
  }
  if (!LIBRARY_FILENAME_PATTERN.test(filename)) {
    throw errors.badRequest('Filename contains invalid characters');
  }
}

/**
 * Resolve effective page size from request params.
 * Exported for use in listFiles.
 */
export function resolvePageSize(requestedLimit: number | undefined, env: Env): number {
  const defaultSize = getListDefaultPageSize(env);
  const maxSize = getListMaxPageSize(env);
  if (!requestedLimit) return defaultSize;
  return Math.min(Math.max(1, requestedLimit), maxSize);
}
