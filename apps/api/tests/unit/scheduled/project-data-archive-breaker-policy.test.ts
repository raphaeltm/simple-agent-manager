import { describe, expect, it } from 'vitest';

import {
  PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_THRESHOLD,
  PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_WINDOW_MS,
  resolveBreakerPoisonPolicy,
} from '../../../src/scheduled/project-data-archive-breaker-policy';

describe('resolveBreakerPoisonPolicy', () => {
  it('uses the defaults when nothing is configured or the value does not parse', () => {
    const expected = {
      breakerPoisonThreshold: PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_THRESHOLD,
      breakerPoisonWindowMs: PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_WINDOW_MS,
    };
    expect(resolveBreakerPoisonPolicy({})).toEqual(expected);
    expect(
      resolveBreakerPoisonPolicy({
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: 'often',
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS: '-5',
      })
    ).toEqual(expected);
  });

  it('honours an in-range value', () => {
    expect(
      resolveBreakerPoisonPolicy({
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '5',
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS: '3600000',
      })
    ).toEqual({ breakerPoisonThreshold: 5, breakerPoisonWindowMs: 3_600_000 });
  });

  it('clamps a window below the minimum up to it, not back to the 24 h default', () => {
    expect(
      resolveBreakerPoisonPolicy({ PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS: '30000' })
        .breakerPoisonWindowMs
    ).toBe(60_000);
  });

  it('clamps values above the maximum down to it', () => {
    expect(
      resolveBreakerPoisonPolicy({
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD: '1000',
        PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS: String(365 * 24 * 60 * 60 * 1000),
      })
    ).toEqual({ breakerPoisonThreshold: 100, breakerPoisonWindowMs: 30 * 24 * 60 * 60 * 1000 });
  });
});
