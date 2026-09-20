import { describe, expect, it } from 'vitest';

import {
  downsamplePreservingSpikes,
  type ResourceSamplePoint,
} from '../../src/services/workspace-resource-history';

describe('workspace resource history', () => {
  it('bounds detail points while preserving first, last, gaps, and spikes', () => {
    const samples: ResourceSamplePoint[] = Array.from({ length: 20 }, (_, index) => ({
      t: index,
      cpuMillis: index === 9 ? 900 : 10,
      memoryBytes: index === 14 ? 900 * 1024 * 1024 : 16 * 1024 * 1024,
      gap: index === 5,
    }));

    const result = downsamplePreservingSpikes(samples, 6);

    expect(result.downsampled).toBe(true);
    expect(result.samples).toHaveLength(6);
    expect(result.samples[0]?.t).toBe(0);
    expect(result.samples.at(-1)?.t).toBe(19);
    expect(result.samples.some((sample) => sample.gap)).toBe(true);
    expect(result.samples.some((sample) => sample.cpuMillis === 900)).toBe(true);
    expect(result.samples.some((sample) => sample.memoryBytes === 900 * 1024 * 1024)).toBe(true);
  });
});
