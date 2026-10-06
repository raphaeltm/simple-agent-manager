import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertBrowserEvidence, expectedBrowserEvidence } from './check-browser-evidence';

const temporaryRoots: string[] = [];

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'browser-evidence-'));
  temporaryRoots.push(root);
  const indexPath = join(root, 'packages/ui/storybook-static/index.json');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify({
      entries: {
        'components-example--primary': {
          id: 'components-example--primary',
          type: 'story',
        },
      },
    })
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('browser evidence manifest', () => {
  it('fails when either Storybook or public-site project evidence is absent', () => {
    const root = createFixture();
    for (const path of expectedBrowserEvidence(root)) {
      if (path.endsWith('www-self-host-mobile-chrome.png')) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'fixture');
    }

    expect(() => assertBrowserEvidence(root)).toThrow('www-self-host-mobile-chrome.png');
  });

  it('passes only when every story/theme/project and public-site screenshot exists', () => {
    const root = createFixture();
    for (const path of expectedBrowserEvidence(root)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'fixture');
    }

    expect(() => assertBrowserEvidence(root)).not.toThrow();
  });
});
