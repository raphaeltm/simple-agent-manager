import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

type StorybookIndex = {
  entries: Record<string, { id: string; type: string }>;
};

const storybookIndex = JSON.parse(
  readFileSync(new URL('../../storybook-static/index.json', import.meta.url), 'utf8')
) as StorybookIndex;
const stories = Object.values(storybookIndex.entries)
  .filter((entry) => entry.type === 'story')
  .map((entry) => entry.id)
  .sort();

if (stories.length === 0) throw new Error('Storybook index does not contain any story entries');

const themes = ['sam', 'sam-light'] as const;
type Theme = (typeof themes)[number];
const AXE_ALREADY_RUNNING_RETRIES = 5;
const AXE_ALREADY_RUNNING_DELAY_MS = 250;

// These existing dark-theme token pairs are below WCAG AA for normal-sized text. WP-065
// cannot change runtime tokens, so keep the debt exact and visible: this test fails if an
// exception disappears, changes shape, or any unlisted serious violation is introduced.
const knownSeriousViolations: Partial<Record<`${Theme}/${string}`, readonly string[]>> = {
  'sam/components-button--danger': ['color-contrast'],
  'sam/components-button--primary': ['color-contrast'],
};

const semanticButtonTokens: Partial<Record<string, { background: string; foreground: string }>> = {
  'components-button--primary': {
    background: '--sam-color-accent-primary',
    foreground: '--sam-color-fg-on-accent',
  },
  'components-button--loading': {
    background: '--sam-color-accent-primary',
    foreground: '--sam-color-fg-on-accent',
  },
  'components-button--danger': {
    background: '--sam-color-danger',
    foreground: '--sam-color-fg-on-accent',
  },
  'components-button--secondary': {
    background: '--sam-color-bg-surface',
    foreground: '--sam-color-fg-primary',
  },
};

function isAxeAlreadyRunning(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Axe is already running');
}

async function analyzeStoryAccessibility(page: Page) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AXE_ALREADY_RUNNING_RETRIES; attempt += 1) {
    try {
      return await new AxeBuilder({ page }).include('#storybook-root').analyze();
    } catch (error) {
      if (!isAxeAlreadyRunning(error)) throw error;
      lastError = error;
      await page.waitForTimeout(AXE_ALREADY_RUNNING_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

for (const theme of themes) {
  for (const story of stories) {
    test(`${story} renders without overflow or unexpected serious axe violations in ${theme}`, async ({
      page,
    }, testInfo) => {
      const query = new URLSearchParams({
        id: story,
        globals: `theme:${theme}`,
        viewMode: 'story',
      });
      await page.goto(`/iframe.html?${query.toString()}`);
      await expect(page.locator('#storybook-root')).not.toBeEmpty();

      const semanticTokens = semanticButtonTokens[story];
      if (semanticTokens) {
        const styles = await page.getByRole('button').evaluate((button, tokens) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = `var(${tokens.background})`;
          probe.style.color = `var(${tokens.foreground})`;
          document.body.append(probe);

          const buttonStyles = getComputedStyle(button);
          const probeStyles = getComputedStyle(probe);
          const resolved = {
            actualBackground: buttonStyles.backgroundColor,
            actualForeground: buttonStyles.color,
            expectedBackground: probeStyles.backgroundColor,
            expectedForeground: probeStyles.color,
          };
          probe.remove();
          return resolved;
        }, semanticTokens);

        expect(styles.actualBackground).toBe(styles.expectedBackground);
        expect(styles.actualForeground).toBe(styles.expectedForeground);
      }

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(hasHorizontalOverflow).toBe(false);

      const axeResults = await analyzeStoryAccessibility(page);
      const seriousViolations = axeResults.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious'
      );
      const exceptionKey = `${theme}/${story}` as const;
      const expectedViolationIds = knownSeriousViolations[exceptionKey] ?? [];
      expect(
        seriousViolations.map((violation) => violation.id).sort(),
        JSON.stringify(seriousViolations, null, 2)
      ).toEqual([...expectedViolationIds].sort());

      if (expectedViolationIds.length > 0) {
        for (const violation of seriousViolations) {
          expect(violation.nodes).toHaveLength(1);
          expect(violation.nodes[0]?.target).toContain('.inline-flex');
        }
        const description = `${exceptionKey}: ${expectedViolationIds.join(', ')}`;
        testInfo.annotations.push({ type: 'known-accessibility-exception', description });
        console.warn(`[known-accessibility-exception] ${description}`);
      }

      const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
      await page.screenshot({
        path: `../../.codex/tmp/playwright-screenshots/storybook-${story}-${theme}-${project}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    });
  }
}
