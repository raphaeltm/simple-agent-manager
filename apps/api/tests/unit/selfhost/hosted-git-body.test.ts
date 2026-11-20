import { describe, expect, it } from 'vitest';

import { ChunkBuffer } from '../../../src/selfhost/hosted-git/hosted-git-body';

describe('ChunkBuffer (Codex r4636751965)', () => {
  it('copies O(total) bytes when a 1 MiB command section arrives one byte at a time', () => {
    const total = 1024 * 1024;
    const buffer = new ChunkBuffer();
    const one = new Uint8Array([0x41]);
    for (let i = 0; i < total; i++) buffer.append(one);
    expect(buffer.length).toBe(total);
    expect(buffer.view(total - 1)).toEqual(one);
    // Re-copying everything read so far on each chunk would be ~total^2 / 2 (5.5e11) bytes.
    expect(buffer.copied).toBeLessThan(4 * total);
  });

  it('keeps an initial body and clamps views to what has been read', () => {
    const buffer = new ChunkBuffer(new Uint8Array([1, 2, 3]));
    buffer.append(new Uint8Array([4, 5]));
    expect([...buffer.view()]).toEqual([1, 2, 3, 4, 5]);
    expect([...buffer.view(3, 99)]).toEqual([4, 5]);
  });
});
