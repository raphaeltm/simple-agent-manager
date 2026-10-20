import { describe, expect, it } from 'vitest';

import { formatDuration } from '../../../src/components/triggers/trigger-presentation';

/** Pins the run-duration strings people already read in a trigger's run history. */
describe('formatDuration', () => {
  // These four cases pin the output of the two implementations this replaced.
  it('reports sub-second runs as "<1s", not raw milliseconds', () => {
    expect(formatDuration('2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.500Z')).toBe('<1s');
  });

  it('omits the seconds component on an exact minute', () => {
    expect(formatDuration('2026-05-01T00:00:00Z', '2026-05-01T00:02:00Z')).toBe('2m');
  });

  it('includes seconds when there is a remainder', () => {
    expect(formatDuration('2026-05-01T00:00:00Z', '2026-05-01T00:02:05Z')).toBe('2m 5s');
  });

  it('reports sub-minute runs in seconds', () => {
    expect(formatDuration('2026-05-01T00:00:00Z', '2026-05-01T00:00:42Z')).toBe('42s');
  });

  it.each([
    ['missing start', null, '2026-05-01T00:00:00Z'],
    ['missing end', '2026-05-01T00:00:00Z', null],
    ['unparseable', 'not-a-date', '2026-05-01T00:00:00Z'],
    ['negative', '2026-05-01T00:01:00Z', '2026-05-01T00:00:00Z'],
  ])('renders an em dash for %s rather than NaN', (_label, a, b) => {
    expect(formatDuration(a, b)).toBe('—');
  });
});
