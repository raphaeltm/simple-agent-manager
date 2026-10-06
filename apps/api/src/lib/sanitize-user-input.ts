// Intentional: the character class deliberately targets raw C0/C1 control-code
// ranges (\x00-\x08 etc.) to strip null bytes and control characters from
// user/agent-supplied text. This is the sanitizer itself, not an accidental
// control character left in a regex literal.
const CONTROL_CHAR_PATTERN =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g; // eslint-disable-line no-control-regex -- sanitizer intentionally matches control characters

/** Strip null bytes, Unicode bidi overrides, and C0/C1 control chars except newline and tab. */
export function sanitizeUserInput(str: string): string {
  return str.replace(CONTROL_CHAR_PATTERN, '');
}
