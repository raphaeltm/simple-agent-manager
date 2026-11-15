import { createHash } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

interface ConversationInventory {
  itemIds: readonly string[];
  anchorIds: readonly string[];
}

function unicodeShape(text: string) {
  let unpairedSurrogates = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
      else unpairedSurrogates++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) unpairedSurrogates++;
  }
  return {
    unicodeScalarCount: [...text].length - unpairedSurrogates,
    unpairedSurrogates,
    replacementChars: (text.match(/\uFFFD/gu) ?? []).length,
  };
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
  const readRows = () =>
    scroller.locator('[data-conversation-item-id]').evaluateAll((elements) =>
      elements.map((element) => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
        const index = Number(element.closest('[data-index]')?.getAttribute('data-index'));
        // Message actions/comments are chrome outside the content node. Cards
        // and tool groups have no prose root, so retain their whole item.
        const contentRoot = element.querySelector('[data-comment-anchor] .prose') ?? element;
        return {
          id: element.getAttribute('data-conversation-item-id')!,
          index,
          anchorId:
            element.querySelector('[data-comment-anchor]')?.getAttribute('data-comment-anchor') ??
            null,
          // Hash message content without comment/action button chrome. Tool
          // groups and typed cards retain their full visible content.
          text: normalize((contentRoot as HTMLElement).innerText),
          structure: [
            ...contentRoot.querySelectorAll(
              'h1,h2,h3,h4,h5,h6,p,ul,ol,li,blockquote,pre,code,a,table,tr,th,td'
            ),
          ]
            .filter(
              (content) =>
                contentRoot !== element || (content as HTMLElement).getClientRects().length > 0
            )
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
  const captured = new Map<string, Snapshot>();
  let previousComplete: Map<string, Snapshot> | null = null;
  let top = 0;
  let reachedEnd = false;
  let seekTail = false;
  const progress: Array<{
    requested: number;
    top: number;
    height: number;
    total: number;
    captured: number;
    first: number;
    last: number;
  }> = [];
  for (let step = 0; step < 300; step++) {
    const soughtTail = seekTail;
    let tailRows: Awaited<ReturnType<typeof readRows>> | undefined;
    if (seekTail) {
      // Let Virtuoso resolve the LAST item against its measured sizes. Repeated
      // raw scrollTop=max writes can otherwise fight its height corrections.
      // Find and invoke the moving control in one browser task, so a remount
      // cannot race a separate visibility check and click.
      const invoked = await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Scroll to bottom"]'
        );
        button?.click();
        return Boolean(button);
      });
      if (!invoked)
        await scroller.evaluate((element) =>
          element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
        );
      if (expected) {
        // Capture the same DOM snapshot that proves the last item mounted.
        // Waiting and reading again can lose it to a subsequent size correction.
        await expect
          .poll(async () => {
            tailRows = await readRows();
            return tailRows.some((row) => row.id === expected.itemIds.at(-1));
          })
          .toBe(true);
      }
      seekTail = false;
    } else {
      await scroller.evaluate((element, position) => {
        element.scrollTop = position;
      }, top);
    }
    if (!tailRows) await page.waitForTimeout(100);
    const rows = tailRows ?? (await readRows());
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
    progress.push({
      requested: top,
      ...position,
      captured: captured.size,
      first: Math.min(...rows.map((row) => row.index)),
      last: Math.max(...rows.map((row) => row.index)),
    });
    if (progress.length > 8) progress.shift();
    const atPhysicalEnd = position.top + position.height >= position.total - 1;
    // A complete independent inventory is semantic end proof even when
    // virtualizer corrections prevent scroll pixels from settling at max.
    const atSemanticEnd =
      expected &&
      captured.size === expected.itemIds.length &&
      expected.itemIds.every((id) => captured.has(id)) &&
      rows.some((row) => row.id === expected.itemIds.at(-1));
    if (atSemanticEnd || (!expected && atPhysicalEnd)) {
      const currentOrdered = [...captured].sort(([, left], [, right]) => left.index - right.index);
      const previousOrdered =
        previousComplete &&
        [...previousComplete].sort(([, left], [, right]) => left.index - right.index);
      if (previousOrdered && JSON.stringify(previousOrdered) === JSON.stringify(currentOrdered)) {
        reachedEnd = true;
        break;
      }
      // Earlier async Markdown/cards can still change after the final card
      // appears. Require two independently complete, identical sweeps; a changed
      // sweep restarts settling, without changing any content/equality check.
      previousComplete = new Map(captured);
      captured.clear();
      top = 0;
      seekTail = false;
      continue;
    }
    if (expected && (atPhysicalEnd || soughtTail)) {
      // A ResizeObserver correction can skip a rendered window during a sweep.
      // Revisit history, retaining observations, until the independent inventory
      // is complete. This still shares the original bounded traversal budget.
      top = 0;
      seekTail = false;
      continue;
    }
    // Advance the requested range independently of corrected browser positions;
    // deriving it only from actual scrollTop can repeat the same two windows.
    top = Math.max(top, position.top) + Math.max(1, Math.floor(position.height * 0.75));
    seekTail = top >= position.total - position.height;
  }
  if (!reachedEnd || captured.size === 0)
    throw new Error(
      `Incomplete rendered conversation audit: ${JSON.stringify({
        progress,
        missingIndices: expected?.itemIds.flatMap((id, index) => (captured.has(id) ? [] : [index])),
      })}`
    );
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
    stableSweeps: 2,
    renderedChars: ordered.reduce((total, [, row]) => total + row.text.length, 0),
    unicodeScalarCount: ordered.reduce(
      (total, [, row]) => total + unicodeShape(row.text).unicodeScalarCount,
      0
    ),
    unpairedSurrogates: ordered.reduce(
      (total, [, row]) => total + unicodeShape(row.text).unpairedSurrogates,
      0
    ),
    replacementChars: ordered.reduce(
      (total, [, row]) => total + unicodeShape(row.text).replacementChars,
      0
    ),
    codeBlocks: ordered.reduce((total, [, row]) => total + row.codeBlocks, 0),
    typedCards: ordered.reduce((total, [, row]) => total + row.typedCards, 0),
  };
}
