/**
 * The arithmetic that makes `selection ceiling > affordability ceiling` unreachable.
 *
 * Both ceilings used to be hand-set, in two different config surfaces, and had to agree. On
 * 2026-09-08 the production write allowance was lowered to 100000 through a GitHub Environment
 * override while `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` stayed at the checked-in 5000, and
 * the sweep spent four days re-picking a session it could never reserve. These cases pin the
 * derivation that replaced the second hand-set number.
 */
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_DEFAULT_SWEEP_UNIT_OVERHEAD_PERCENT,
  ARCHIVE_WRITE_FIXED_RESERVATION,
  archiveAffordableMessageCeiling,
  archiveAffordableWriteUnits,
} from '../../../src/project-data-archive/write-budget';

describe('archive affordability ceilings', () => {
  it('reproduces the production numbers that deadlocked the sweep', () => {
    // The deployed values on 2026-09-12.
    const allowance = 100_000;
    const factor = 32;

    expect(archiveAffordableWriteUnits(allowance, factor)).toBe(3093);
    // At the default overhead allowance the ceiling lands well below the 4994-message session
    // the sweep kept choosing, and below the 5000 the drifted config still admitted.
    const ceiling = archiveAffordableMessageCeiling(
      allowance,
      factor,
      ARCHIVE_DEFAULT_SWEEP_UNIT_OVERHEAD_PERCENT
    );
    expect(ceiling).toBe(1546);
    expect(ceiling).toBeLessThan(4994);
  });

  it('keeps a ceiling-sized session inside the allowance at the assumed overhead', () => {
    const allowance = 100_000;
    const factor = 32;
    const overhead = ARCHIVE_DEFAULT_SWEEP_UNIT_OVERHEAD_PERCENT;
    const ceiling = archiveAffordableMessageCeiling(allowance, factor, overhead);

    // A session exactly at the ceiling, whose real unit count is exactly the assumed overhead,
    // must still fit. This is the invariant the whole derivation exists to hold; if the
    // arithmetic drifted (a rounding direction, a stray +1), this is what would catch it.
    const worstCaseUnits = ceiling * (1 + overhead / 100);
    expect(ARCHIVE_WRITE_FIXED_RESERVATION + factor * worstCaseUnits).toBeLessThanOrEqual(
      allowance
    );
  });

  it('returns zero when the allowance cannot afford any session', () => {
    // Selecting nothing is correct here: fencing a candidate that can never be reserved is
    // strictly worse than not selecting it.
    expect(archiveAffordableWriteUnits(1_000, 32)).toBe(0);
    expect(archiveAffordableWriteUnits(0, 32)).toBe(0);
    expect(archiveAffordableWriteUnits(500, 32)).toBe(0);
    expect(archiveAffordableMessageCeiling(1_000, 32, 100)).toBe(0);
  });

  it('treats a zero or negative factor as 1 rather than dividing by it', () => {
    expect(archiveAffordableWriteUnits(11_000, 0)).toBe(10_000);
    expect(archiveAffordableWriteUnits(11_000, -5)).toBe(10_000);
  });

  it('scales the ceiling with the overhead allowance', () => {
    const allowance = 100_000;
    const factor = 32;
    // 0% overhead assumes message_count IS the unit count — the most permissive ceiling.
    expect(archiveAffordableMessageCeiling(allowance, factor, 0)).toBe(3093);
    expect(archiveAffordableMessageCeiling(allowance, factor, 100)).toBe(1546);
    expect(archiveAffordableMessageCeiling(allowance, factor, 900)).toBe(309);
  });

  it('raising the allowance raises the ceiling, so the two can never disagree again', () => {
    // wrangler.toml's pre-2026-09-08 value. The point of the derivation: whoever changes the
    // allowance changes the selection ceiling with it, in the same expression.
    expect(archiveAffordableWriteUnits(250_000, 32)).toBe(7781);
    expect(archiveAffordableMessageCeiling(250_000, 32, 100)).toBe(3890);
    expect(archiveAffordableMessageCeiling(250_000, 32, 100)).toBeGreaterThan(
      archiveAffordableMessageCeiling(100_000, 32, 100)
    );
  });
});
