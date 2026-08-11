import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';

describe('trial placement migration', () => {
  it('adds one nullable JSON audit column without rewriting trial rows', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'src/db/migrations/0110_trial_placement_explanation.sql'),
      'utf8'
    );
    expect(sql).toContain('ALTER TABLE trials ADD COLUMN placement_explanation_json TEXT;');
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE/i);
    expect(schema.trials.placementExplanationJson).toBeDefined();
  });
});
