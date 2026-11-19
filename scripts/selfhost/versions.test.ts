import { describe, expect, it } from 'vitest';

import { celldReleaseTarget } from './celld-binary.js';
import { CELLD_RELEASE_SHA256 } from './versions.js';

describe('pinned versions', () => {
  it('has a checksum for every release target it can select', () => {
    for (const [os, cpu] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'arm64'],
    ] as const) {
      expect(CELLD_RELEASE_SHA256[celldReleaseTarget(os, cpu)]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(() => celldReleaseTarget('win32', 'x64')).toThrow(/set CELLD_BIN/);
  });
});
