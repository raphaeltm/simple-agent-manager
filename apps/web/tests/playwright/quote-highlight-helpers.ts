/**
 * Reading and clicking comment-quote highlights in a real browser. Highlights are CSS Custom
 * Highlight API ranges, not elements, so they are read from `CSS.highlights` and clicked at the
 * screen position of their first line box.
 */
import { expect, type Page } from '@playwright/test';

export const ACTIVE_QUOTE = 'sam-comment-quote';
export const OTHER_QUOTE = 'sam-comment-quote-other';

/** The text of every range painted under `name`. */
export function paintedQuotes(page: Page, name: string): Promise<string[]> {
  return page.evaluate(
    (highlightName) =>
      [...(CSS.highlights.get(highlightName) ?? [])].map((range) => range.toString()),
    name
  );
}

/** Centre of the first line of the painted range whose text is `text`. */
async function paintedPoint(page: Page, text: string) {
  const point = await page.evaluate(
    ({ wanted, names }) => {
      for (const name of names) {
        for (const range of CSS.highlights.get(name) ?? []) {
          if (range.toString() !== wanted) continue;
          const rect = (range as Range).getClientRects()[0];
          if (rect)
            return { x: rect.left + Math.min(rect.width / 2, 24), y: rect.top + rect.height / 2 };
        }
      }
      return null;
    },
    { wanted: text, names: [OTHER_QUOTE, ACTIVE_QUOTE] }
  );
  expect(point, `painted words "${text}" must have a layout box`).not.toBeNull();
  return point!;
}

/** Click (or, on a touch viewport, tap) the painted words, the way a reader would. */
export async function clickPaintedWords(page: Page, text: string): Promise<void> {
  const { x, y } = await paintedPoint(page, text);
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Hover the painted words; the surface under them shows a pointer. */
export async function hoverPaintedWords(page: Page, text: string): Promise<void> {
  const { x, y } = await paintedPoint(page, text);
  await page.mouse.move(x, y);
}

/** Whether the painted range with this text is inside its scroller's visible area. */
export function paintedWordsOnScreen(page: Page, name: string, text: string): Promise<boolean> {
  return page.evaluate(
    ({ highlightName, wanted }) => {
      for (const range of CSS.highlights.get(highlightName) ?? []) {
        if (range.toString() !== wanted) continue;
        const box = (range as Range).getBoundingClientRect();
        let scroller = (range as Range).startContainer.parentElement;
        while (scroller) {
          const overflow = getComputedStyle(scroller).overflowY;
          if (
            (overflow === 'auto' || overflow === 'scroll') &&
            scroller.scrollHeight > scroller.clientHeight
          ) {
            break;
          }
          scroller = scroller.parentElement;
        }
        const view =
          scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
        return box.height > 0 && box.top >= view.top && box.bottom <= view.bottom;
      }
      return false;
    },
    { highlightName: name, wanted: text }
  );
}
