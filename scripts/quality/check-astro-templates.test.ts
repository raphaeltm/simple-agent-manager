import { describe, expect, it } from 'vitest';

import {
  exceedsAstroErrorBaseline,
  isCompleteAstroCheckResult,
  parseAstroCheckBaseline,
  parseAstroCheckSummary,
} from './check-astro-templates';

describe('Astro template validation ratchet', () => {
  it('runtime-validates the checked-in JSON baseline', () => {
    expect(
      parseAstroCheckBaseline(
        JSON.stringify({
          errors: 6,
          metadata: { owner: 'quality', backlog: 'task', review: 'date' },
        })
      )
    ).toMatchObject({ errors: 6 });
    expect(() => parseAstroCheckBaseline('{"errors":"6","metadata":{}}')).toThrow();
  });

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
    expect(parseAstroCheckSummary('Result (1 files):\n- 0 errors')).toBeUndefined();
    const complete = { errors: 0, warnings: 0, hints: 0 };
    expect(isCompleteAstroCheckResult(0, complete, undefined)).toBe(true);
    expect(isCompleteAstroCheckResult(1, complete, undefined)).toBe(true);
    expect(isCompleteAstroCheckResult(2, complete, undefined)).toBe(false);
    expect(isCompleteAstroCheckResult(0, complete, new Error('spawn failed'))).toBe(false);
  });
});
