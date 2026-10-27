/**
 * Shared by the comment reader's audit and its docs capture: chat message rows shaped the way the
 * API returns them, and the check that the open comment's words are highlighted on screen.
 */
import { expect, type Page } from '@playwright/test';

export interface MessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
  sequence: number;
}

/**
 * Message rows for one chat, numbered in the order they're made. `startAt` restarts the numbering,
 * so a page of earlier or later messages gets the sequence numbers a real chat would.
 */
export function messageRowsFor(sessionId: string) {
  let sequence = 0;
  const row = (
    id: string,
    role: string,
    content: string,
    at: number,
    toolMetadata: Record<string, unknown> | null = null
  ): MessageRow => {
    sequence += 1;
    return { id, sessionId, role, content, toolMetadata, createdAt: at, sequence };
  };
  /** An agent reply stored the way the VM agent stores it: one row per streamed chunk. */
  const streamed = (prefix: string, text: string, at: number): MessageRow[] => {
    const words = text.split(/(?<= )/);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 4) chunks.push(words.slice(i, i + 4).join(''));
    return chunks.map((chunk, index) =>
      row(`${prefix}-${index + 1}`, 'assistant', chunk, at + index)
    );
  };
  const startAt = (next: number) => {
    sequence = next;
  };
  return { row, streamed, startAt };
}

/** The open comment's words are painted and inside the visible part of the conversation. */
export async function expectQuoteOnScreen(page: Page, quoteStart: string) {
  const result = await page.evaluate((needle) => {
    const registry = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
    const range = registry?.get('sam-comment-quote')?.values().next().value;
    if (!(range instanceof Range)) return 'missing';
    if (!range.toString().startsWith(needle)) return `wrong:${range.toString().slice(0, 40)}`;
    const scroller = document.querySelector('[data-reader-scroller]');
    if (!scroller) return 'no-scroller';
    const view = scroller.getBoundingClientRect();
    const box = range.getBoundingClientRect();
    const sheet = document.querySelector('section[aria-label="Comment thread"]');
    const bottom = sheet ? Math.min(view.bottom, sheet.getBoundingClientRect().top) : view.bottom;
    return box.top >= view.top && box.bottom <= bottom
      ? 'visible'
      : `offscreen:${box.top}-${box.bottom}/${view.top}-${bottom}`;
  }, quoteStart);
  expect(result).toBe('visible');
}
