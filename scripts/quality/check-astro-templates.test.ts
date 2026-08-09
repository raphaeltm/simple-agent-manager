import { describe, expect, it } from 'vitest';

import { exceedsAstroErrorBaseline, parseAstroCheckSummary } from './check-astro-templates';

describe('Astro template validation ratchet', () => {
  it('parses deterministic error, warning, and hint totals', () => {
    expect(
      parseAstroCheckSummary(`Result (45 files):\n- 6 errors\n- 2 warnings\n- 18 hints\n`)
    ).toEqual({ errors: 6, warnings: 2, hints: 18 });
  });

  it('passes equal/decreased debt and fails a net increase', () => {
    expect(exceedsAstroErrorBaseline({ errors: 6, warnings: 0, hints: 0 }, 6)).toBe(false);
    expect(exceedsAstroErrorBaseline({ errors: 5, warnings: 0, hints: 0 }, 6)).toBe(false);
    expect(exceedsAstroErrorBaseline({ errors: 7, warnings: 0, hints: 0 }, 6)).toBe(true);
  });

  it('fails closed when Astro does not emit a complete result', () => {
    expect(parseAstroCheckSummary('Astro crashed before diagnostics.')).toBeUndefined();
  });
});
