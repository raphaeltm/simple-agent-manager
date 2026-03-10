/**
 * Strips common markdown formatting from a string for use in plain-text UI contexts.
 *
 * Only strips double-marker emphasis (**bold**, __bold__) — NOT single markers
 * (*italic*, _italic_) because those corrupt snake_case identifiers that commonly
 * appear in LLM-generated session topics (e.g. `fix user_profile_update handler`).
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/~~(.+?)~~/g, '$1')        // ~~strikethrough~~
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s+/gm, '')        // # headings
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // [link](url)
    .trim();
}
