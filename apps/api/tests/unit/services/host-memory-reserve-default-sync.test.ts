import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
  resolveEffectiveNodeHostMemoryReserveMb,
} from '../../../src/services/workspace-resource-capacity';

/**
 * One host reserve drives offering selection, admission and the cloud-init workload-slice cap
 * (rule 69). The API always passes its resolved value to cloud-init, so the package fallback only
 * applies to direct package users, but it must not drift from the API default either.
 */
describe('host memory reserve default', () => {
  it('matches the cloud-init fallback for the workload-slice reserve', () => {
    const source = readFileSync(
      resolve(process.cwd(), '../../packages/cloud-init/src/generate.ts'),
      'utf8'
    );
    const match = /variables\.vmAgentMemoryReserveMb \?\? '(\d+)'/.exec(source);
    expect(match, 'cloud-init vmAgentMemoryReserveMb fallback not found').not.toBeNull();
    expect(Number(match?.[1])).toBe(DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB);
  });

  it('is what an unconfigured deployment resolves', () => {
    expect(resolveEffectiveNodeHostMemoryReserveMb({})).toBe(
      DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB
    );
  });
});
