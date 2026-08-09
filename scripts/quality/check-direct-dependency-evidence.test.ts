import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkDirectDependencyEvidence,
  extractDirectDependencyAdditions,
} from './check-direct-dependency-evidence';

const fixtureRoot = join(import.meta.dirname, 'fixtures/supply-chain');
const readFixture = (name: string) => readFileSync(join(fixtureRoot, name), 'utf8');

describe('direct dependency evidence checker', () => {
  it('requires authoritative evidence and necessity for production npm additions', () => {
    const result = checkDirectDependencyEvidence(readFixture('direct-dependency-add.diff'), {
      npm: {},
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Missing direct dependency evidence for npm:left-pad');
  });

  it('accepts registry/homepage evidence with a one-line necessity', () => {
    const result = checkDirectDependencyEvidence(readFixture('direct-dependency-add.diff'), {
      npm: {
        'left-pad': {
          registryUrl: 'https://www.npmjs.com/package/left-pad',
          necessity: 'Pads deterministic fixture values.',
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it('flags malformed evidence without printing package contents', () => {
    const result = checkDirectDependencyEvidence(readFixture('go-dependency-add.diff'), {
      go: {
        'golang.org/x/crypto': {
          registryUrl: 'http://pkg.go.dev/golang.org/x/crypto',
          necessity: 'crypto',
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'go:golang.org/x/crypto registryUrl must be an https URL',
      'go:golang.org/x/crypto needs a one-line necessity with at least three words',
    ]);
  });

  it('does not require evidence for removals, version updates, dev dependencies, or workspace/internal dependencies', () => {
    const diffs = [
      'dependency-update-remove.diff',
      'direct-dependency-dev.diff',
      'direct-dependency-workspace.diff',
    ].map(readFixture);

    for (const diff of diffs) {
      const result = checkDirectDependencyEvidence(diff, {});
      expect(result.ok).toBe(true);
    }
  });

  it('extracts Go direct additions from module manifests only', () => {
    const additions = extractDirectDependencyAdditions(readFixture('go-dependency-add.diff'));

    expect(additions).toEqual([
      {
        ecosystem: 'go',
        manifestPath: 'packages/vm-agent/go.mod',
        name: 'golang.org/x/crypto',
        production: true,
        internal: false,
      },
    ]);
  });
});
