import { SAFE_FILENAME_REGEX } from './types';

/** Name used when nothing usable survives sanitization. */
export const DEFAULT_SANITIZED_FILENAME = 'file';

/**
 * Rewrite a user-supplied filename so it satisfies `SAFE_FILENAME_REGEX`.
 *
 * Accents are folded to their base letter ("résumé" → "resume"), every run of
 * other disallowed characters becomes a single underscore, and surrounding
 * whitespace is trimmed. A name with no letters or digits left (including "."
 * and "..") falls back to `fallback`. The extension is kept when it is safe,
 * so "CleanShot 12.22.51@2x.png" becomes "CleanShot 12.22.51_2x.png".
 */
export function sanitizeFilename(name: string, fallback = DEFAULT_SANITIZED_FILENAME): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._\- ]+/g, '_')
    .trim();
  if (!/[a-zA-Z0-9]/.test(cleaned) || !SAFE_FILENAME_REGEX.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}
