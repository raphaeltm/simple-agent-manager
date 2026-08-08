import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type StorybookIndex = {
  entries: Record<string, { id: string; type: string }>;
};

const THEMES = ['sam', 'sam-light'] as const;
const PROJECTS = ['desktop-chrome', 'mobile-chrome'] as const;

export function expectedBrowserEvidence(root: string): string[] {
  const indexPath = resolve(root, 'packages/ui/storybook-static/index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`Browser evidence check failed: missing Storybook index ${indexPath}`);
  }

  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as StorybookIndex;
  const stories = Object.values(index.entries)
    .filter((entry) => entry.type === 'story')
    .map((entry) => entry.id)
    .sort((left, right) => left.localeCompare(right));
  if (stories.length === 0) {
    throw new Error('Browser evidence check failed: Storybook index has no stories');
  }

  const storybookEvidence = stories.flatMap((story) =>
    THEMES.flatMap((theme) =>
      PROJECTS.map((project) =>
        resolve(
          root,
          `.codex/tmp/playwright-screenshots/storybook-${story}-${theme}-${project}.png`
        )
      )
    )
  );
  const publicSiteEvidence = PROJECTS.map((project) =>
    resolve(root, `.codex/tmp/playwright-screenshots/www-self-host-${project}.png`)
  );
  return [...storybookEvidence, ...publicSiteEvidence];
}

export function assertBrowserEvidence(root: string): void {
  const missing = expectedBrowserEvidence(root).filter((path) => !existsSync(path));
  if (missing.length === 0) return;

  throw new Error(
    [
      'Browser evidence check failed: required screenshots are missing:',
      ...missing.map((p) => `- ${p}`),
    ].join('\n')
  );
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    assertBrowserEvidence(repositoryRoot);
    console.log('Browser evidence: Storybook and public-site screenshots exist for every project');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
