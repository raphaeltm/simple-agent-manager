import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MirrorChart } from '../../../../../src/components/node/usage/MirrorChart';

const MINUTE = 60_000;

function chart(starts: number[]) {
  const { container } = render(
    <MirrorChart
      series={{
        start: starts,
        cpuMillis: starts.map(() => 500),
        memoryBytes: starts.map(() => 1_000_000_000),
      }}
      windowStart={0}
      windowEnd={60 * MINUTE}
      bucketMs={MINUTE}
      memoryMax={4_000_000_000}
      cpuMax={2000}
      memoryReserved={null}
      cpuReserved={null}
      className="h-10"
    />
  );
  return container.querySelectorAll('polyline').length;
}

describe('MirrorChart', () => {
  it('breaks the lines where history has no buckets, instead of drawing across the gap', () => {
    // Two runs, each drawn once for memory and once for CPU.
    expect(chart([0, 1, 2, 20, 21].map((m) => m * MINUTE))).toBe(4);
    // Control: contiguous minutes draw one run per metric.
    expect(chart([0, 1, 2, 3, 4].map((m) => m * MINUTE))).toBe(2);
  });
});
