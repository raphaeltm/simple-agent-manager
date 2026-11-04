import { SAFE_FILENAME_REGEX } from './types';

/** Name used when nothing usable survives sanitization. */
export const DEFAULT_SANITIZED_FILENAME = 'file';

/**
 * Longest sanitized name, in characters. The output is ASCII, so this is also
 * bytes: the 255-byte single path component limit (NAME_MAX) the VM agent hits
 * when it writes the attachment into the workspace.
 */
export const MAX_SANITIZED_FILENAME_LENGTH = 255;

/** Extensions longer than this are treated as part of the name when truncating. */
const MAX_KEPT_EXTENSION_LENGTH = 16;

/**
 * Rewrite a user-supplied filename so it satisfies `SAFE_FILENAME_REGEX`.
 *
 * Surrounding whitespace is trimmed, accents are folded to their base letter
 * ("résumé" → "resume"), and every run of spaces or other disallowed characters
 * becomes a single underscore, so the result never contains a space. Names
 * longer than `MAX_SANITIZED_FILENAME_LENGTH` are shortened, keeping the
 * extension. A name with no letters or digits left (including "." and "..")
 * becomes `DEFAULT_SANITIZED_FILENAME`. So "CleanShot 12.22.51@2x.png" becomes
 * "CleanShot_12.22.51_2x.png".
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
  const bounded = truncateFilename(cleaned);
  if (!/[a-zA-Z0-9]/.test(bounded) || !SAFE_FILENAME_REGEX.test(bounded)) {
    return DEFAULT_SANITIZED_FILENAME;
  }
  return bounded;
}

function truncateFilename(name: string): string {
  if (name.length <= MAX_SANITIZED_FILENAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const extension =
    dot > 0 && name.length - dot <= MAX_KEPT_EXTENSION_LENGTH ? name.slice(dot) : '';
  return name.slice(0, MAX_SANITIZED_FILENAME_LENGTH - extension.length) + extension;
}
