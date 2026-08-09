import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkDirectDependencyEvidence,
  compareManifestSnapshots,
  directDependencyAdditionsAgainstBase,
  extractDirectDependencyAdditions,
  loadEvidence,
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

  it('does not require evidence for removals, version updates, or workspace/internal dependencies', () => {
    const diffs = ['dependency-update-remove.diff', 'direct-dependency-workspace.diff'].map(
      readFixture
    );

    for (const diff of diffs) {
      const result = checkDirectDependencyEvidence(diff, {});
      expect(result.ok).toBe(true);
    }
  });

  it('requires evidence for direct dev dependency additions too', () => {
    const missing = checkDirectDependencyEvidence(readFixture('direct-dependency-dev.diff'), {});
    expect(missing.errors).toContain('Missing direct dependency evidence for npm:vitest');

    const present = checkDirectDependencyEvidence(readFixture('direct-dependency-dev.diff'), {
      npm: {
        vitest: {
          registryUrl: 'https://www.npmjs.com/package/vitest',
          necessity: 'Runs deterministic unit test fixtures.',
        },
      },
    });
    expect(present.ok).toBe(true);
  });

  it('detects additions in the repository-root package manifest', () => {
    const additions = extractDirectDependencyAdditions(
      `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -3,0 +4,3 @@\n+  "dependencies": {\n+    "root-package": "1.0.0"\n+  }\n`
    );
    expect(additions).toMatchObject([
      { ecosystem: 'npm', manifestPath: 'package.json', name: 'root-package' },
    ]);
  });

  it('compares complete npm snapshots when a zero-context patch omits the section name', () => {
    expect(
      compareManifestSnapshots(
        'package.json',
        JSON.stringify({ scripts: { test: 'vitest' }, dependencies: {} }),
        JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { valibot: '1.2.0' } })
      )
    ).toEqual([
      {
        ecosystem: 'npm',
        manifestPath: 'package.json',
        name: 'valibot',
        production: true,
        internal: false,
      },
    ]);
  });

  it('wires the repository check to manifest snapshots instead of diff context', () => {
    const root = mkdtempSync(join(tmpdir(), 'sam-dependency-evidence-'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, dependencies: {} }, null, 2)
    );
    execFileSync('git', ['add', 'package.json'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base', '--quiet'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { valibot: '1.2.0' } }, null, 2)
    );

    expect(directDependencyAdditionsAgainstBase(root, base)).toMatchObject([
      { ecosystem: 'npm', manifestPath: 'package.json', name: 'valibot' },
    ]);
  });

  it('fails closed when the durable evidence file is missing', () => {
    expect(() => loadEvidence(join(tmpdir(), 'missing-sam-dependency-evidence.json'))).toThrow(
      'evidence file is missing'
    );
  });

  it('does not treat transitive Go requirements as direct additions', () => {
    const result = checkDirectDependencyEvidence(
      `diff --git a/packages/vm-agent/go.mod b/packages/vm-agent/go.mod\n--- a/packages/vm-agent/go.mod\n+++ b/packages/vm-agent/go.mod\n@@ -3,0 +4 @@\n+require golang.org/x/text v0.3.0 // indirect\n`,
      {}
    );
    expect(result).toMatchObject({ ok: true, additions: [] });
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

  it('treats a Go tool directive as direct dependency evidence', () => {
    expect(
      compareManifestSnapshots(
        'scripts/quality/govulncheck-tool/go.mod',
        'module example.com/tools\n\ngo 1.25.0\n',
        'module example.com/tools\n\ngo 1.25.0\n\ntool golang.org/x/vuln/cmd/govulncheck\n'
      )
    ).toEqual([
      {
        ecosystem: 'go',
        manifestPath: 'scripts/quality/govulncheck-tool/go.mod',
        name: 'golang.org/x/vuln/cmd/govulncheck',
        production: true,
        internal: false,
      },
    ]);
  });
});
