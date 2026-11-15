import { createHash } from 'node:crypto';

import type { Page } from '@playwright/test';

interface ConversationInventory {
  itemIds: readonly string[];
  anchorIds: readonly string[];
}

/**
 * Capture all loaded display items, in their actual virtual-list order. Pass an
 * independently derived inventory to prove that paging reached the whole history.
 * Call only after the agent and async cards have settled; hashes contain no text.
 */
export async function captureFullConversation(page: Page, expected?: ConversationInventory) {
  const scroller = page.locator('[data-sam-conversation-scroller="true"]');
  await scroller.waitFor({ state: 'visible' });
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    const earlier = scroller.getByRole('button', { name: 'Load earlier messages', exact: true });
    if (!(await earlier.count())) break;
    await earlier.click();
    await page.waitForTimeout(200);
    if (pageNumber === 99) throw new Error('Conversation history exceeded the audit page bound');
  }
  type Snapshot = {
    index: number;
    anchorId: string | null;
    text: string;
    structure: Array<{ tag: string; text: string; href: string | null; language: string | null }>;
    codeBlocks: number;
    typedCards: number;
  };
  const captured = new Map<string, Snapshot>();
  let top = 0;
  let reachedEnd = false;
  for (let step = 0; step < 300; step++) {
    await scroller.evaluate((element, position) => {
      element.scrollTop = position;
    }, top);
    await page.waitForTimeout(100);
    const rows = await scroller.locator('[data-conversation-item-id]').evaluateAll((elements) =>
      elements.map((element) => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
        const index = Number(element.closest('[data-index]')?.getAttribute('data-index'));
        return {
          id: element.getAttribute('data-conversation-item-id')!,
          index,
          anchorId:
            element.querySelector('[data-comment-anchor]')?.getAttribute('data-comment-anchor') ??
            null,
          // Full visible item text includes tool groups and typed cards, which
          // are not comment anchors and need not contain a .prose element.
          text: normalize((element as HTMLElement).innerText),
          structure: [
            ...element.querySelectorAll(
              'h1,h2,h3,h4,h5,h6,p,ul,ol,li,blockquote,pre,code,a,table,tr,th,td'
            ),
          ]
            .filter((content) => (content as HTMLElement).getClientRects().length > 0)
            .map((content) => ({
              tag: content.tagName.toLowerCase(),
              text: content.closest('pre')
                ? (content.textContent ?? '')
                : normalize(content.textContent ?? ''),
              href: content.getAttribute('href'),
              language: content.tagName === 'CODE' ? content.className : null,
            })),
          codeBlocks: element.querySelectorAll('pre').length,
          typedCards: element.querySelectorAll('[data-testid$="-card"]').length,
        };
      })
    );
    for (const { id, ...row } of rows) {
      if (!Number.isSafeInteger(row.index)) throw new Error('Missing conversation item position');
      const previous = captured.get(id);
      if (previous && previous.index !== row.index)
        throw new Error('Conversation changed during audit');
      captured.set(id, row);
    }
    const position = await scroller.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      total: element.scrollHeight,
    }));
    if (position.top + position.height >= position.total - 1) {
      reachedEnd = true;
      break;
    }
    top = position.top + Math.max(1, Math.floor(position.height * 0.75));
  }
  if (!reachedEnd || captured.size === 0) throw new Error('Incomplete rendered conversation audit');
  const ordered = [...captured].sort(([, left], [, right]) => left.index - right.index);
  if (ordered.some(([, row], index) => row.index !== index)) {
    throw new Error('Conversation audit skipped virtualized display items');
  }
  const itemIds = ordered.map(([id]) => id);
  const anchorIds = ordered.flatMap(([, row]) => (row.anchorId ? [row.anchorId] : []));
  if (
    expected &&
    (JSON.stringify(itemIds) !== JSON.stringify(expected.itemIds) ||
      JSON.stringify(anchorIds) !== JSON.stringify(expected.anchorIds))
  ) {
    throw new Error('Rendered conversation inventory differs from expected history');
  }
  // Only metadata leaves this helper; reply text stays in this process's memory.
  return {
    renderedHash: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'),
    itemIds,
    anchorIds,
    inventoryVerified: Boolean(expected),
    renderedChars: ordered.reduce((total, [, row]) => total + row.text.length, 0),
    codeBlocks: ordered.reduce((total, [, row]) => total + row.codeBlocks, 0),
    typedCards: ordered.reduce((total, [, row]) => total + row.typedCards, 0),
  };
}
