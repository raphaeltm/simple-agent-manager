/**
 * The heap-limit detector (apps/api/src/scheduled/isolate-heap-limit-core.ts) keys on celld's own
 * refusal text, which celld embeds in its binary (js/harness.js `SqlCursor.toArray`). A celld bump
 * that reworded it would leave detection silently dead with every unit test green, so this reads
 * the pinned, checksum-verified release itself. Idea 01M7W6ZTZETXE75N8NRKR3R0CF.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ISOLATE_HEAP_LIMIT_MARKER } from '../../../apps/api/src/scheduled/isolate-heap-limit-core';
import { ensureCelldBinary } from '../celld-binary.js';
import { LIVE_TMP } from './harness';

describe('the pinned celld refuses with the text the detector matches', () => {
  it('embeds ISOLATE_HEAP_LIMIT_MARKER in its SQL materialisation refusal', async () => {
    const binary = readFileSync(await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')));
    // Liveness: this is the harness source, not an empty or wrong file.
    expect(binary.includes('materializing a result set (see CELLD_V8_HEAP_LIMIT_MB)')).toBe(true);
    expect(binary.includes(`the isolate is ${ISOLATE_HEAP_LIMIT_MARKER}, so it stopped`)).toBe(
      true
    );
    // Control: the search can fail.
    expect(binary.includes('over its V8 heap budget')).toBe(false);
  });
});
