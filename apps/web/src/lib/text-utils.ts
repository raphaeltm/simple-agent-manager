/** Strips common markdown formatting from a string for use in plain-text UI contexts. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/~~(.+?)~~/g, '$1')        // ~~strikethrough~~
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s+/gm, '')        // # headings
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // [link](url)
    .trim();
}
