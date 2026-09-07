import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd(), '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('node-pool legacy compatibility boundary', () => {
  it('keeps legacy VM-size helpers out of core capacity placement', () => {
    const corePlacement = readRepoFile('apps/api/src/services/placement-resolver-capacity.ts');

    expect(corePlacement).not.toContain('canSatisfyVmSize');
    expect(corePlacement).not.toContain('PROVIDER_VM_CAPACITY');
    expect(corePlacement).not.toContain('PLATFORM_RESOURCE_DEFAULTS');
  });

  it('would fail for a forbidden direct legacy-size read fixture', () => {
    const forbiddenFixture = `
      import { canSatisfyVmSize } from '@simple-agent-manager/shared';
      export const matches = canSatisfyVmSize('small', 'medium');
    `;

    expect(forbiddenFixture).toContain('canSatisfyVmSize');
  });
});
