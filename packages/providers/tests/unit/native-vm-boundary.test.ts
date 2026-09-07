import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PROVIDER_SRC = new URL('../../src/', import.meta.url);
const COMPATIBILITY_MODULE = 'native-vm-config.ts';
const ALLOWED_LEGACY_SIZE_FILES = new Set([
  COMPATIBILITY_MODULE,
  'instance-offerings.ts',
  'types.ts',
]);

function providerSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return providerSourceFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

function disallowedLegacySizeReads(source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /\bVMConfig\b.*\bsize\b|\bconfig\.size\b/.test(line))
    .map(({ line, lineNumber }) => `${lineNumber}: ${line.trim()}`);
}

describe('native VM legacy-size boundary', () => {
  it('keeps legacy-size reads inside named compatibility modules', () => {
    const violations = providerSourceFiles(PROVIDER_SRC.pathname).flatMap((file) => {
      const relative = file.slice(PROVIDER_SRC.pathname.length);
      if (ALLOWED_LEGACY_SIZE_FILES.has(relative)) return [];
      return disallowedLegacySizeReads(readFileSync(file, 'utf8')).map((line) => `${relative}:${line}`);
    });

    expect(violations).toEqual([]);
  });

  it('detector fixture fails for a provider create path that reads config.size', () => {
    const failureFixture = `
      async createVM(config: VMConfig) {
        const type = this.sizes[config.size].type;
        return this.create(type);
      }
    `;

    expect(disallowedLegacySizeReads(failureFixture)).toEqual([
      '3: const type = this.sizes[config.size].type;',
    ]);
  });
});
