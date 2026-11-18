/**
 * The advisory reservation parser (scheduler-core) and the final-admission SQL (worker) must
 * accept exactly the same reservation sources. Both derive from RESOURCE_REQUIREMENTS_SOURCES;
 * this pins the SQL fragment to the exact text the atomic reservation used before the split, and
 * proves every source in the list round-trips through the advisory parser.
 */
import {
  isResolvedResourceReservation,
  RESOURCE_REQUIREMENTS_SOURCES,
} from '@simple-agent-manager/scheduler-core';
import { describe, expect, it } from 'vitest';

import { RESOURCE_REQUIREMENTS_SOURCE_SQL } from '../../../src/services/workspace-reservation-usage';

function reservation(source: string) {
  return { version: 3, cpuMillis: 1000, memoryMb: 1024, diskMb: 0, exclusiveNode: false, source };
}

describe('reservation source parity between scheduler-core and the admission SQL', () => {
  it('keeps the final-admission SQL list unchanged', () => {
    expect(RESOURCE_REQUIREMENTS_SOURCE_SQL).toBe(
      "'task', 'trigger', 'skill', 'agent-profile', 'project', 'user', 'platform'"
    );
  });

  it('accepts every source the SQL accepts, and nothing else', () => {
    const sqlSources = RESOURCE_REQUIREMENTS_SOURCE_SQL.split(', ').map((value) =>
      value.slice(1, -1)
    );
    expect(sqlSources).toEqual([...RESOURCE_REQUIREMENTS_SOURCES]);
    for (const source of sqlSources) {
      expect(isResolvedResourceReservation(reservation(source))).toBe(true);
    }
    expect(isResolvedResourceReservation(reservation('unknown-source'))).toBe(false);
  });
});
