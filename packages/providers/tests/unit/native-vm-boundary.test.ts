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

const FORBIDDEN_LEGACY_AUTHORITY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bconfig\s*\.\s*size\b/, reason: 'config.size read' },
  { pattern: /\bconfig\s*\[\s*['"]size['"]\s*\]/, reason: 'config["size"] read' },
  { pattern: /\{\s*[^}]*\bsize\b[^}]*\}\s*=\s*config\b/, reason: 'config size destructuring' },
  { pattern: /\bthis\s*\.\s*sizes\s*\[/, reason: 'this.sizes bracket lookup' },
  { pattern: /\bObject\s*\.\s*values\s*\(\s*this\s*\.\s*sizes\s*\)/, reason: 'this.sizes Object.values lookup' },
];

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
    .flatMap(({ line, lineNumber }) =>
      FORBIDDEN_LEGACY_AUTHORITY_PATTERNS.filter(({ pattern }) => pattern.test(line)).map(
        ({ reason }) => `${lineNumber}: ${reason}: ${line.trim()}`
      )
    );
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

  it('detector fixture fails for realistic provider create-path legacy authority reads', () => {
    const failureFixture = `
      async createVM(config: VMConfig) {
        const type = this.sizes[config.size].type;
        const { size } = config;
        const bracket = config['size'];
        const alias = config.size;
        const match = Object.values(this.sizes).find((candidate) => candidate.type === config.native.instanceType);
        return this.create(type);
      }
    `;

    expect(disallowedLegacySizeReads(failureFixture)).toEqual([
      '3: config.size read: const type = this.sizes[config.size].type;',
      '3: this.sizes bracket lookup: const type = this.sizes[config.size].type;',
      '4: config size destructuring: const { size } = config;',
      "5: config[\"size\"] read: const bracket = config['size'];",
      '6: config.size read: const alias = config.size;',
      '7: this.sizes Object.values lookup: const match = Object.values(this.sizes).find((candidate) => candidate.type === config.native.instanceType);',
    ]);
  });

  it('detector fixture allows native provider API size fields and compatibility boundaries', () => {
    const allowedFixture = `
      const body = { size: nativeConfig.instanceType, disk_size: nativeConfig.bootDiskSizeGb };
      const style = { inlineSize: '100%' };
      const adapter = resolveVMConfigWithLegacySizeAdapter(config, { legacySizes: this.sizes });
      const publicCatalog = getProviderInstanceOfferings(provider).map((offering) => offering.legacyVmSize);
    `;

    expect(disallowedLegacySizeReads(allowedFixture)).toEqual([]);
  });
});
