/**
 * Behavioral tests for route helper utilities.
 *
 * Verifies requireRouteParam and parsePositiveInt work correctly.
 * requireRouteParam is the canonical version used across all route files
 * (chat.ts, activity.ts, tasks, etc.) — duplicates have been removed.
 */
import { describe, expect, it } from 'vitest';

import { parsePositiveInt, requireRouteParam } from '../../../src/lib/route-helpers';

describe('requireRouteParam', () => {
  function makeContext(params: Record<string, string | undefined>) {
    return {
      req: {
        param: (name: string) => params[name],
      },
    };
  }

  it('returns the param value when present', () => {
    const c = makeContext({ projectId: 'proj-123' });
    expect(requireRouteParam(c, 'projectId')).toBe('proj-123');
  });

  it('throws AppError with 400 status when param is missing', () => {
    const c = makeContext({});
    expect(() => requireRouteParam(c, 'projectId')).toThrow();
    try {
      requireRouteParam(c, 'projectId');
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('projectId');
    }
  });

  it('throws when param value is undefined', () => {
    const c = makeContext({ projectId: undefined });
    expect(() => requireRouteParam(c, 'projectId')).toThrow();
  });

  it('returns empty string if param value is empty string', () => {
    const c = makeContext({ projectId: '' });
    // Empty string is falsy, so it should throw
    expect(() => requireRouteParam(c, 'projectId')).toThrow();
  });
});

describe('parsePositiveInt', () => {
  it('returns parsed integer for valid positive number string', () => {
    expect(parsePositiveInt('42', 10)).toBe(42);
  });

  it('returns fallback for undefined', () => {
    expect(parsePositiveInt(undefined, 10)).toBe(10);
  });

  it('returns fallback for non-numeric string', () => {
    expect(parsePositiveInt('abc', 10)).toBe(10);
  });

  it('returns fallback for zero', () => {
    expect(parsePositiveInt('0', 10)).toBe(10);
  });

  it('returns fallback for negative number', () => {
    expect(parsePositiveInt('-5', 10)).toBe(10);
  });

  it('returns fallback for empty string', () => {
    expect(parsePositiveInt('', 10)).toBe(10);
  });
});
