/**
 * Branch name generation service.
 *
 * Generates human-readable git branch names from user messages.
 * Uses task ID suffix for guaranteed uniqueness (no TOCTOU race).
 *
 * See: specs/022-simplified-chat-ux/research.md (R6)
 */

const DEFAULT_PREFIX = 'sam/';
const DEFAULT_MAX_LENGTH = 60;
const MAX_MEANINGFUL_WORDS = 4;

/**
 * Common English stop words to filter from branch names.
 * Keeps branch names focused on meaningful content words.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'in',
  'on',
  'of',
  'is',
  'it',
  'at',
  'by',
  'be',
  'as',
  'do',
  'if',
  'or',
  'so',
  'up',
  'and',
  'but',
  'not',
  'are',
  'was',
  'can',
  'has',
  'had',
  'with',
  'will',
  'from',
  'this',
  'that',
  'they',
  'them',
  'then',
  'than',
  'been',
  'have',
  'just',
  'also',
  'into',
  'some',
  'when',
  'what',
  'which',
  'would',
  'could',
  'should',
  'about',
  'their',
  'there',
  'these',
  'those',
  'other',
  'please',
  'want',
  'need',
  'like',
  'make',
  'sure',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
]);

interface BranchNameOptions {
  prefix?: string;
  maxLength?: number;
}

/**
 * Generate a branch name from a user message and task ID.
 *
 * Algorithm:
 * 1. Lowercase the message
 * 2. Remove non-alphanumeric characters (keep spaces, hyphens)
 * 3. Split into words, filter stop words
 * 4. Take first N meaningful words
 * 5. Join with hyphens
 * 6. Append short task ID suffix (first 6 chars, lowercased)
 * 7. Prefix with configurable prefix
 * 8. Truncate to max length
 * 9. Ensure valid git ref name
 */
export function generateBranchName(
  message: string,
  taskId: string,
  options: BranchNameOptions = {}
): string {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  // Short task ID suffix (first 6 chars of ULID, lowercased)
  const idSuffix = taskId.slice(0, 6).toLowerCase();

  // Step 1: Lowercase
  let text = message.toLowerCase();

  // Step 2: Remove non-alphanumeric except spaces and hyphens
  text = text.replace(/[^a-z0-9\s-]/g, '');

  // Step 3: Split and filter
  const words = text
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  // Step 4: Take first N meaningful words
  const meaningful = words.slice(0, MAX_MEANINGFUL_WORDS);

  // Handle edge case: no meaningful words
  if (meaningful.length === 0) {
    return sanitizeGitRef(`${prefix}task-${idSuffix}`, maxLength);
  }

  // Step 5: Join with hyphens
  const slug = meaningful.join('-');

  // Step 6+7: Combine prefix + slug + suffix
  const raw = `${prefix}${slug}-${idSuffix}`;

  // Step 8+9: Truncate and sanitize
  return sanitizeGitRef(raw, maxLength);
}

/**
 * Ensure a string is a valid git ref name.
 * See: https://git-scm.com/docs/git-check-ref-format
 */
function sanitizeGitRef(ref: string, maxLength: number): string {
  let result = ref;

  // Truncate, but preserve the suffix (last 7 chars: '-' + 6-char ID)
  if (result.length > maxLength) {
    const suffix = result.slice(result.lastIndexOf('-'));
    const availableForSlug = maxLength - suffix.length;
    if (availableForSlug > 0) {
      const prefixAndSlug = result.slice(0, result.lastIndexOf('-'));
      result = prefixAndSlug.slice(0, availableForSlug) + suffix;
    } else {
      result = result.slice(0, maxLength);
    }
  }

  // No consecutive dots
  result = result.replace(/\.{2,}/g, '.');

  // No trailing dot, slash, or hyphen
  result = result.replace(/[./-]+$/, '');

  // No leading dot or hyphen after the prefix slash
  result = result.replace(/\/[.-]+/g, '/');

  // Remove any remaining invalid sequences
  result = result.replace(/\s+/g, '-');
  result = result.replace(/-{2,}/g, '-');

  return result;
}
