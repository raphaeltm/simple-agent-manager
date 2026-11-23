// Test-only preload (NODE_OPTIONS=--import=...): shifts this process's clock by
// SAM_TEST_CLOCK_OFFSET_MS, so a real deploy seals a bundle dated in the past (a host clock that
// moved backwards). Used by bundle-head.test.ts; never loaded outside tests.
const offset = Number(process.env.SAM_TEST_CLOCK_OFFSET_MS ?? '0');
if (Number.isFinite(offset) && offset !== 0) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
