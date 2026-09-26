import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { UpdateProjectSchema } from '../../../src/schemas/projects';

describe('UpdateProjectSchema', () => {
  it('drops the retired maxWorkspacesPerNode from older clients instead of rejecting the update', () => {
    const parsed = v.safeParse(UpdateProjectSchema, {
      name: 'renamed',
      warmNodeTimeoutMs: 600_000,
      maxWorkspacesPerNode: 4,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The supported fields still apply; the retired per-node count cap is not stored.
      expect(parsed.output).toEqual({ name: 'renamed', warmNodeTimeoutMs: 600_000 });
    }
  });
});
