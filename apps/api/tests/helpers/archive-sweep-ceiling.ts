/**
 * The archive sweep ceilings the test suite exercises, in one place.
 *
 * `node:fs` does not exist inside workerd, so a Worker test cannot read the shipped
 * `[vars]` the way `tests/unit/project-data-archive/sweep-message-budget-shipped.test.ts`
 * does. Putting the value here instead of retyping it in the Worker test keeps a single
 * definition that ONE unit case pins against `apps/api/wrangler.toml`
 * (`.claude/rules/70`): edit the shipped var without editing this file and that case goes
 * red, naming both values.
 *
 * An earlier draft solved this by reading the TOML in `vitest.workers.config.ts` and
 * passing it through `provide`. That is not viable here: the reviewed-Gitleaks baseline
 * digests a finding's start LINE, and that file holds a synthetic PEM fixture, so adding
 * imports above it shifts the line and invalidates the review. Do not reintroduce it.
 */

/**
 * The ceiling `apps/api/wrangler.toml` ships. Production step 1 of the archive throughput
 * rollout; 20000 is exercised separately as an explicit experiment (see
 * `SWEEP_CEILING_EXPERIMENT`) and is not shipped.
 */
export const SHIPPED_SWEEP_MESSAGE_BUDGET = 10_000;

/** The ceiling production ran until 2026-09-20, and the one that hid the band above it. */
export const PREVIOUS_SWEEP_MESSAGE_BUDGET = 5_000;

/**
 * The per-tick session slot count `apps/api/wrangler.toml` ships.
 *
 * Bound to the shipped value for the same reason the ceiling is: the Worker test's `sweepEnv`
 * has to reproduce the deployed configuration, and a hardcoded copy would let a later edit
 * leave the suite green while it exercised a shape that is no longer shipped
 * (`.claude/rules/70`). Note this value does NOT currently bind throughput — the wall-time
 * gate ends the tick after the first candidate — so it is pinned for fidelity, not because
 * changing it would change the drain.
 */
export const SHIPPED_SWEEP_SESSIONS = 8;

/**
 * A candidate size beyond the shipped ceiling, run as an experiment rather than as a claim
 * about shipped config. It exists to measure whether the compact state machine stays
 * correct at 4x the largest session production has ever published (4,994), so a later
 * promotion has evidence behind it rather than an extrapolation.
 */
export const SWEEP_CEILING_EXPERIMENT = 20_000;
