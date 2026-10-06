import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

// Mermaid draws every label as SVG text, never as HTML. In a real browser, that
// text must still read the way the HTML labels did: light on section-coloured
// shapes, centred in the mindmap root, in the diagram's own font, and as whole
// words when a long label wraps.

const PROJECT_ID = 'proj-mermaid-labels';
const SESSION_ID = 'sess-mermaid-labels';
const WRAPPED_LABEL = 'Render a Mermaid diagram inside the chat bubble without any HTML labels';

const DIAGRAMS = [
  'journey\n  title Working day\n  section Go to work\n    Make tea: 5: Me',
  'timeline\n  title History\n  2002 : LinkedIn\n  2004 : Facebook : Google',
  'mindmap\n  root((Mindmap root))\n    Origins\n      Long history\n    Research',
  'kanban\n  Todo\n    [Create docs]\n  Done\n    [Ship it]',
  `flowchart LR\n  A[${WRAPPED_LABEL}] --> B[Short]`,
];

/** Labels Mermaid draws on section-coloured shapes. */
const SECTION_LABELS = [
  'Go to work',
  'Make tea',
  '2002',
  'LinkedIn',
  'Google',
  'Mindmap root',
  'Origins',
  'Research',
  'Todo',
  'Done',
  'Create docs',
];

const DIAGRAMS_MESSAGE = {
  id: 'msg-mermaid-labels',
  sessionId: SESSION_ID,
  role: 'assistant',
  content: DIAGRAMS.map((source) => ['```mermaid', source, '```'].join('\n')).join('\n\n'),
  toolMetadata: null,
  createdAt: Date.now() - 20_000,
  sequence: 1,
};

async function openDiagrams(page: Page) {
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: {
      id: PROJECT_ID,
      name: 'Mermaid Labels',
      repository: 'user/mermaid-labels',
      repoProvider: 'github',
      createdAt: '2026-09-27T00:00:00Z',
      updatedAt: '2026-09-27T00:00:00Z',
    },
    session: {
      id: SESSION_ID,
      workspaceId: null,
      taskId: null,
      topic: 'Mermaid labels',
      status: 'stopped',
      messageCount: 1,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 5_000,
      endedAt: Date.now() - 5_000,
      cleanupAt: null,
      isIdle: false,
      agentCompletedAt: null,
      agentSessionId: null,
      agentType: 'claude-code',
    },
    messages: [DIAGRAMS_MESSAGE],
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.locator('[data-testid="mermaid-diagram-svg"] > svg')).toHaveCount(
    DIAGRAMS.length,
    { timeout: 30_000 }
  );
}

/** The SVG <text> element that draws exactly `label`. */
function labelText(page: Page, label: string) {
  return page
    .locator('[data-testid="mermaid-diagram-svg"] text')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .first();
}

/** WCAG relative luminance of a computed `rgb(...)` colour. */
function luminance(rgb: string): number {
  const channels = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

for (const [viewportName, viewport, isMobile] of [
  ['mobile', { width: 375, height: 667 }, true],
  ['desktop', { width: 1280, height: 800 }, false],
] as const) {
  test.describe(`Mermaid labels — ${viewportName}`, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test('stay light on section-coloured shapes', async ({ page }) => {
      await openDiagrams(page);

      for (const label of SECTION_LABELS) {
        const fill = await labelText(page, label).evaluate((node) => getComputedStyle(node).fill);
        // The dark theme is otherwise black or dark grey on these fills.
        expect(luminance(fill), `${label} is drawn in ${fill}`).toBeGreaterThan(0.5);
      }
      await screenshot(page, `mermaid-labels-${viewportName}`);
      await assertNoOverflow(page);
    });

    test('centre the mindmap root in its circle', async ({ page }) => {
      await openDiagrams(page);

      const label = labelText(page, 'Mindmap root');
      const offset = await label.evaluate((node) => {
        const circle = node.closest('.mindmap-node')?.querySelector('circle');
        if (!circle) throw new Error('The mindmap root has no circle');
        const text = node.getBoundingClientRect();
        const shape = circle.getBoundingClientRect();
        return text.left + text.width / 2 - (shape.left + shape.width / 2);
      });
      expect(Math.abs(offset)).toBeLessThanOrEqual(1);
    });

    test('draw journey labels in the diagram font', async ({ page }) => {
      await openDiagrams(page);

      const font = await labelText(page, 'Make tea').evaluate((node) => {
        const style = getComputedStyle(node.querySelector('tspan') ?? node);
        return { size: style.fontSize, family: style.fontFamily };
      });
      expect(font.size).toBe('16px');
      expect(font.family).toMatch(/^system-ui/);
    });

    test('read a wrapped label as words and keep its rows centred', async ({ page }) => {
      await openDiagrams(page);

      const label = page
        .locator('[data-testid="mermaid-diagram-svg"] text')
        .filter({ hasText: /^Render/ })
        .first();
      const { text, rowCentres } = await label.evaluate((node) => ({
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        // Centre of each row's ink, from its first glyph to its last visible one.
        // A row's box would hide a shift: it grows with any trailing space.
        rowCentres: Array.from(node.querySelectorAll<SVGTSpanElement>('tspan.row'), (row) => {
          const lastGlyph = (row.textContent ?? '').trimEnd().length - 1;
          return (row.getStartPositionOfChar(0).x + row.getEndPositionOfChar(lastGlyph).x) / 2;
        }),
      }));
      expect(rowCentres.length).toBeGreaterThan(1);
      expect(text).toBe(WRAPPED_LABEL);
      // Word breaks take no width, so every row keeps the label's centre.
      expect(Math.max(...rowCentres) - Math.min(...rowCentres)).toBeLessThan(0.5);
    });
  });
}
