import { describe, expect, it } from 'vitest';

import {
  classifyFile,
  EXEMPT_FILES,
  EXEMPT_PATTERNS,
  HARD_LIMIT,
  SCAN_DIRECTORIES,
  WARN_LIMIT,
} from './check-file-sizes';

// classifyFile is pure (no filesystem/process access) by design: main()'s
// `find ${SCAN_DIRECTORIES.join(' ')} ...` runs against ROOT, which is
// anchored to this script's own file location (import.meta.dirname) rather
// than process.cwd(), so a subprocess sandbox (as used by
// check-no-tracked-stale-binaries.test.ts) cannot redirect the scan root.
// Testing the extracted pure function is the hermetic equivalent.

function linesOfCode(count: number): string {
  return Array.from({ length: count }, (_, i) => `// line ${i}`).join('\n');
}

describe('check-file-sizes — scan roots', () => {
  it('includes scripts/ alongside apps/ and packages/', () => {
    expect(SCAN_DIRECTORIES).toEqual(expect.arrayContaining(['apps/', 'packages/', 'scripts/']));
  });
});

describe('check-file-sizes — classifyFile', () => {
  it('returns null for a small file', () => {
    expect(classifyFile('scripts/quality/tiny.ts', linesOfCode(10))).toBeNull();
  });

  it('flags a scripts/ file between the warn and hard limits as a warning', () => {
    const content = linesOfCode(WARN_LIMIT + 50);
    const result = classifyFile('scripts/deploy/warn-example.ts', content);

    expect(result).toEqual({
      file: 'scripts/deploy/warn-example.ts',
      lines: WARN_LIMIT + 50,
      severity: 'warning',
    });
  });

  it('flags a scripts/ file over the hard limit as an error', () => {
    // classifyFile itself was always path-agnostic; combined with the
    // SCAN_DIRECTORIES assertion above (the actual discriminating change —
    // main()'s `find` never visited scripts/ before it was added there),
    // this proves the full scan+classify path now covers scripts/ files.
    const content = linesOfCode(HARD_LIMIT + 50);
    const result = classifyFile('scripts/deploy/oversized-example.ts', content);

    expect(result).toEqual({
      file: 'scripts/deploy/oversized-example.ts',
      lines: HARD_LIMIT + 50,
      severity: 'error',
    });
  });

  it('exempts a scripts/ file over the hard limit when it documents a FILE SIZE EXCEPTION', () => {
    const content = `// FILE SIZE EXCEPTION: synthetic fixture.\n${linesOfCode(HARD_LIMIT + 50)}`;

    expect(classifyFile('scripts/deploy/exempted-example.ts', content)).toBeNull();
  });

  it('still classifies apps/ and packages/ files the same as before', () => {
    const content = linesOfCode(HARD_LIMIT + 50);

    expect(classifyFile('apps/api/src/oversized-example.ts', content)).toEqual({
      file: 'apps/api/src/oversized-example.ts',
      lines: HARD_LIMIT + 50,
      severity: 'error',
    });
  });

  it('skips files matching EXEMPT_PATTERNS regardless of directory', () => {
    const content = linesOfCode(HARD_LIMIT + 50);

    expect(classifyFile('scripts/quality/huge.test.ts', content)).toBeNull();
  });

  it('skips files listed in EXEMPT_FILES', () => {
    const [firstExemptFile] = EXEMPT_FILES;
    expect(firstExemptFile).toBeDefined();
    const content = linesOfCode(HARD_LIMIT + 50);

    expect(classifyFile(firstExemptFile as string, content)).toBeNull();
  });

  it('sanity-checks EXEMPT_PATTERNS actually matches a representative test-file name', () => {
    expect(EXEMPT_PATTERNS.some((pattern) => pattern.test('scripts/quality/huge.test.ts'))).toBe(
      true
    );
  });
});
