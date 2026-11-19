import { describe, expect, it, vi } from 'vitest';

import {
  chargeGitWork,
  readGitChunk,
  withGitWorkBudget,
} from '../../../src/vendor/dgit/git/budget';
import { applyDelta } from '../../../src/vendor/dgit/git/pack';
import { deflate, inflate } from '../../../src/vendor/dgit/git/zlib';

const limits = { maxObjectBytes: 32, maxInflatedBytes: 48, maxDeltaDepth: 2, workTimeoutMs: 1000 };

describe('hosted git work budget', () => {
  it('bounds loose-object reads after garbage collection and charges repeated inflations', () => {
    const small = deflate(new Uint8Array(24));
    const large = deflate(new Uint8Array(33));
    withGitWorkBudget(limits, () => {
      expect(() => inflate(large)).toThrow('inflated size limit');
      expect(inflate(small)).toHaveLength(24);
      expect(inflate(small)).toHaveLength(24);
      expect(() => inflate(small)).toThrow('decompression budget');
    });
  });

  it('rejects a delta target before allocation, while a valid delta works', () => {
    withGitWorkBudget(limits, () => {
      expect(() => applyDelta(new Uint8Array(), new Uint8Array([0, 33]))).toThrow(
        'inflated size limit'
      );
      expect(applyDelta(new Uint8Array(), new Uint8Array([0, 1, 1, 65]))).toEqual(
        new Uint8Array([65])
      );
    });
  });

  it('charges cumulative decompression and isolates concurrent requests', async () => {
    await Promise.all(
      [1, 2].map(() =>
        withGitWorkBudget(limits, async () => {
          chargeGitWork(32);
          await Promise.resolve();
          chargeGitWork(16);
          expect(() => chargeGitWork(1)).toThrow('decompression budget');
        })
      )
    );
  });

  it('checks the deadline during CPU work', () => {
    vi.useFakeTimers();
    try {
      withGitWorkBudget(limits, () => {
        chargeGitWork(1);
        vi.advanceTimersByTime(1000);
        expect(() => chargeGitWork(1)).toThrow('time budget');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a stalled upload instead of retaining the receive lock', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    try {
      const reader = new ReadableStream<Uint8Array>({ cancel }).getReader();
      const result = withGitWorkBudget(limits, () => readGitChunk(reader));
      const rejected = expect(result).rejects.toThrow('time budget');
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
