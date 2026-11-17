/**
 * `apps/api/wrangler.toml` leaves out every `[vars]` entry whose value equals the code default,
 * because each entry is a Cloudflare text binding and a Worker may only carry so many. The names
 * and values left out are recorded in `OMITTED_WORKER_VAR_DEFAULTS`
 * (`scripts/deploy/worker-var-defaults.ts`). This suite proves the omission changes nothing, by
 * running the production read paths rather than comparing copied constants:
 *
 * 1. Every read path resolves the same configuration with the recorded values absent as with them
 *    present, for local/self-host inputs and for the staging and production GitHub Environments.
 * 2. Setting each omitted var to another value changes at least one read path, so (1) cannot pass
 *    because the paths ignore the var.
 * 3. Every source file that reads an omitted var is exercised by a read path that observes it, so a
 *    new read site with its own fallback cannot appear unnoticed (`.claude/rules/61`, requirement 2).
 *    Every omitted var must have a read site the scan finds, so a read the scan cannot see (a key
 *    built in some new way) fails here instead of leaving (3) vacuously true for that var.
 *
 * When a code default changes, (1) fails until the record in `worker-var-defaults.ts` changes with
 * it, so a deployed behaviour change is always deliberate (`.claude/rules/07`).
 */
import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { OMITTED_WORKER_VAR_DEFAULTS } from '../../../../../scripts/deploy/worker-var-defaults';
import {
  alternativeValue,
  INPUTS,
  shippedVars,
  valueReferences,
} from './omitted-worker-var-defaults-helpers';
import { READ_PATHS, type ReadPath } from './omitted-worker-var-read-paths';

describe('Worker vars omitted from wrangler.toml because they equal the code default', () => {
  const omitted = OMITTED_WORKER_VAR_DEFAULTS;
  const shipped = shippedVars();

  it('omits each recorded var from wrangler.toml [vars]', () => {
    expect(Object.keys(omitted).length).toBeGreaterThan(150);
    expect(Object.keys(omitted).filter((name) => name in shipped)).toEqual([]);
  });

  for (const { label, overrides } of INPUTS) {
    it(`resolves every read path identically without the recorded values (${label})`, async () => {
      const after = { ...shipped, ...overrides };
      const before = { ...shipped, ...omitted, ...overrides };
      for (const readPath of READ_PATHS) {
        expect(await readPath.read(after), readPath.label).toEqual(await readPath.read(before));
      }
    });
  }

  // Parses every source file that mentions an omitted name, so allow for a loaded CI runner.
  it('observes every omitted var through a read path that covers each file reading it', async () => {
    const base = { ...shipped };
    const references = valueReferences(new Set(Object.keys(omitted)));
    // A broken scan would report every var as covered; it must find the bulk of the read sites.
    expect(
      [...references.values()].reduce((count, files) => count + files.size, 0)
    ).toBeGreaterThan(150);

    // A var read only through an indirection the scan cannot see would make the coverage check
    // below vacuous for it, so every omitted var must have at least one read site found.
    expect(
      Object.keys(omitted).filter((name) => !references.has(name)),
      'omitted vars with no read site the scan can see'
    ).toEqual([]);

    const unobserved: string[] = [];
    const uncovered: string[] = [];
    for (const [name, value] of Object.entries(omitted)) {
      const changed = { ...base, [name]: alternativeValue(name, value) };
      const observing: ReadPath[] = [];
      for (const readPath of READ_PATHS) {
        if (!isDeepStrictEqual(await readPath.read(changed), await readPath.read(base)))
          observing.push(readPath);
      }
      if (observing.length === 0) unobserved.push(name);
      const covered = new Set(observing.flatMap((readPath) => readPath.sources));
      for (const file of references.get(name) ?? []) {
        if (!covered.has(file)) uncovered.push(`${name} read in ${file}`);
      }
    }
    expect(unobserved, 'no read path changes when these vars change').toEqual([]);
    expect(uncovered, 'read sites no observing read path exercises').toEqual([]);
  }, 60_000);
});
