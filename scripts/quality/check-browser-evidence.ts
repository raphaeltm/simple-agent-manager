import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type StorybookIndex = {
  entries: Record<string, { id: string; type: string }>;
};

const THEMES = ['sam', 'sam-light'] as const;
const PROJECTS = ['desktop-chrome', 'mobile-chrome'] as const;

function hasJsonObjectShape(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStorybookIndex(indexPath: string): StorybookIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Browser evidence check failed: invalid Storybook index ${indexPath}: ${String(error)}`
    );
  }

  if (!hasJsonObjectShape(parsed)) {
    throw new Error(`Browser evidence check failed: Storybook index ${indexPath} is not an object`);
  }

  const rawEntries = Reflect.get(parsed, 'entries');
  if (!hasJsonObjectShape(rawEntries)) {
    throw new Error(
      `Browser evidence check failed: Storybook index ${indexPath} has no entries object`
    );
  }

  const entries: StorybookIndex['entries'] = {};
  for (const [key, rawEntry] of Object.entries(rawEntries)) {
    if (!hasJsonObjectShape(rawEntry)) {
      throw new Error(`Browser evidence check failed: Storybook entry ${key} is not an object`);
    }

    const id = Reflect.get(rawEntry, 'id');
    const type = Reflect.get(rawEntry, 'type');
    if (typeof id !== 'string' || typeof type !== 'string') {
      throw new Error(`Browser evidence check failed: Storybook entry ${key} has invalid id/type`);
    }
    entries[key] = { id, type };
  }

  return { entries };
}

export function expectedBrowserEvidence(root: string): string[] {
  const indexPath = resolve(root, 'packages/ui/storybook-static/index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`Browser evidence check failed: missing Storybook index ${indexPath}`);
  }

  const index = readStorybookIndex(indexPath);
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
