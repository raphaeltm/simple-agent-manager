/**
 * Regressions for two request-plan roundtrip defects.
 *
 * Finding 2 — an explicit Run `resourceRequirements` object/null set
 * `ignoreLegacyResourceRequirementsJson`, which discarded the stored legacy row
 * whatever its source. Rows sourced from skill/trigger/agent-profile/project/user
 * are INHERITED requirements a task-level override does not replace, so they were
 * erased.
 *
 * Finding 3 — the stored-reservation normalizer dropped `diagnostics` and
 * per-field `compatibility`, so a no-op retry erased the legacy vm-size
 * translation audit trail.
 */
import {
  type ResolvedResourceReservation,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  createPersistedTaskResourcePlanJson,
  readPersistedTaskResourcePlan,
  ResourceRequirementsValidationError,
} from '../../../src/services/resource-requirements-input';

const BASE = {
  taskId: 'task-1',
  projectId: 'project-1',
  userId: 'user-1',
} as const;

/** The exact shape the reproduced production row had: legacy JSON, no plan, no reservation. */
function legacyTaskRow(source: string, json: string) {
  return {
    ...BASE,
    resourceRequirementsJson: json,
    resourceRequirementsSource: source,
  };
}

describe('explicit Run task override preserves inherited resource layers', () => {
  // Each inherited source, with the explicit-object and explicit-null forms of the
  // Run override. Both set ignoreLegacyResourceRequirementsJson identically.
  const INHERITED_SOURCES: ReadonlyArray<[source: string, layer: string]> = [
    ['skill', 'skill'],
    ['agent-profile', 'agentProfile'],
    ['trigger', 'trigger'],
    ['project', 'project'],
    ['user', 'user'],
  ];

  for (const [source, layer] of INHERITED_SOURCES) {
    it(`keeps a valid ${source}-sourced layer when Run supplies an explicit override`, () => {
      const result = readPersistedTaskResourcePlan(
        legacyTaskRow(source, JSON.stringify({ minVcpu: 4, minMemoryGb: 12 })),
        { ignoreLegacyResourceRequirementsJson: true }
      );

      expect(result.source).toBe('legacy-source-json');
      expect(result.layers).toEqual({ [layer]: { minVcpu: 4, minMemoryGb: 12 } });
      // Nothing landed on the task layer, so a Run that sets or deletes
      // `layers.task` cannot disturb the inherited requirement.
      expect(result.layers.task).toBeUndefined();
    });
  }

  it('still suppresses the task-sourced layer the explicit override replaces', () => {
    const result = readPersistedTaskResourcePlan(
      legacyTaskRow('task', JSON.stringify({ minVcpu: 8 })),
      { ignoreLegacyResourceRequirementsJson: true }
    );

    expect(result.layers).toEqual({});
    expect(result.source).toBe('empty');
  });

  it('repairs a MALFORMED task-sourced layer instead of rejecting the request', () => {
    expect(() =>
      readPersistedTaskResourcePlan(legacyTaskRow('task', '{not json'), {
        ignoreLegacyResourceRequirementsJson: true,
      })
    ).not.toThrow();

    // The repair escape hatch exists only because an explicit replacement is
    // supplied; without it the malformed row is still rejected.
    expect(() => readPersistedTaskResourcePlan(legacyTaskRow('task', '{not json'), {})).toThrow(
      ResourceRequirementsValidationError
    );
  });

  it('rejects a MALFORMED unrelated layer rather than silently dropping it', () => {
    // The explicit task override does not replace the skill layer, so a broken
    // skill row must not be swallowed by the repair path.
    expect(() =>
      readPersistedTaskResourcePlan(
        legacyTaskRow('skill', JSON.stringify({ minVcpu: 'banana' })),
        { ignoreLegacyResourceRequirementsJson: true }
      )
    ).toThrow(ResourceRequirementsValidationError);
  });

  it('treats an unattributable legacy row as repairable, since no layer can claim it', () => {
    // Without an explicit replacement this row is rejected as ambiguous...
    expect(() =>
      readPersistedTaskResourcePlan({
        ...BASE,
        resourceRequirementsJson: JSON.stringify({ minVcpu: 4 }),
        resourceRequirementsSource: 'not-a-real-source',
      })
    ).toThrow(/ambiguous without resourceRequirementsSource/);

    // ...and with one it is repaired, because it cannot be attributed to any
    // inherited layer that the override would be erasing.
    const repaired = readPersistedTaskResourcePlan(
      {
        ...BASE,
        resourceRequirementsJson: JSON.stringify({ minVcpu: 4 }),
        resourceRequirementsSource: 'not-a-real-source',
      },
      { ignoreLegacyResourceRequirementsJson: true }
    );
    expect(repaired.layers).toEqual({});
  });

  it('omitted intent still reads the stored layer unchanged', () => {
    const result = readPersistedTaskResourcePlan(
      legacyTaskRow('skill', JSON.stringify({ minVcpu: 4, minMemoryGb: 12 }))
    );
    expect(result.layers).toEqual({ skill: { minVcpu: 4, minMemoryGb: 12 } });
  });
});

describe('persisted reservation roundtrip preserves full semantic provenance', () => {
  /** A reservation carrying real legacy-adapter compatibility notes and diagnostics. */
  function legacyAdapterReservation(): ResolvedResourceReservation {
    const reservation = resolveResourceReservation(
      {},
      { taskId: 'task-1', projectId: 'project-1', userId: 'user-1' },
      { legacyVmSizes: { project: 'medium' } }
    );
    // Guard the fixture: if the resolver stops emitting these, the roundtrip
    // assertions below would pass vacuously.
    expect(reservation.diagnostics?.length ?? 0).toBeGreaterThan(0);
    expect(reservation.fieldProvenance?.minVcpu?.compatibility).toBeDefined();
    return reservation;
  }

  it('round-trips diagnostics and per-field compatibility through resolvedReservationJson', () => {
    const reservation = legacyAdapterReservation();

    const readBack = readPersistedTaskResourcePlan({
      ...BASE,
      resolvedReservationJson: JSON.stringify(reservation),
    });

    expect(readBack.source).toBe('reservation-provenance');
    expect(readBack.resolvedReservation).toEqual(reservation);
  });

  it('round-trips diagnostics and per-field compatibility through the versioned plan', () => {
    const reservation = legacyAdapterReservation();
    const planJson = createPersistedTaskResourcePlanJson({
      layers: { skill: { minVcpu: 4 } },
      resolvedReservation: reservation,
      requestedVmSize: 'medium',
      requestedVmSizeSource: 'project',
    });

    const readBack = readPersistedTaskResourcePlan({
      ...BASE,
      resourceRequirementPlanJson: planJson,
    });

    expect(readBack.source).toBe('plan-v1');
    expect(readBack.resolvedReservation).toEqual(reservation);

    // A second no-op roundtrip must be a fixed point, not a slow erosion.
    const rewritten = createPersistedTaskResourcePlanJson({
      layers: readBack.layers,
      resolvedReservation: readBack.resolvedReservation as ResolvedResourceReservation,
      requestedVmSize: readBack.requestedVmSize,
      requestedVmSizeSource: readBack.requestedVmSizeSource,
    });
    expect(JSON.parse(rewritten)).toEqual(JSON.parse(planJson));
  });

  it('preserves an empty diagnostics array distinctly from an absent one', () => {
    const withEmpty = readPersistedTaskResourcePlan({
      ...BASE,
      resolvedReservationJson: JSON.stringify({
        ...resolveResourceReservation({ task: { minVcpu: 2 } }, BASE),
        diagnostics: [],
      }),
    });
    expect(withEmpty.resolvedReservation?.diagnostics).toEqual([]);

    const base = resolveResourceReservation({ task: { minVcpu: 2 } }, BASE);
    const { diagnostics: _dropped, ...withoutDiagnostics } = base;
    const absent = readPersistedTaskResourcePlan({
      ...BASE,
      resolvedReservationJson: JSON.stringify(withoutDiagnostics),
    });
    expect(absent.resolvedReservation?.diagnostics).toBeUndefined();
  });

  it('preserves exclusiveNode false and disk 0 alongside the new fields', () => {
    const reservation = resolveResourceReservation(
      { task: { minVcpu: 1, minMemoryGb: 1, minDiskGb: 0, exclusiveNode: false, maxCoTenants: 3 } },
      BASE
    );
    const readBack = readPersistedTaskResourcePlan({
      ...BASE,
      resolvedReservationJson: JSON.stringify(reservation),
    });
    expect(readBack.resolvedReservation?.diskMb).toBe(0);
    expect(readBack.resolvedReservation?.exclusiveNode).toBe(false);
    expect(readBack.resolvedReservation).toEqual(reservation);
  });

  it('stays strict about malformed untrusted diagnostics and compatibility', () => {
    const base = resolveResourceReservation({ task: { minVcpu: 2 } }, BASE);

    expect(() =>
      readPersistedTaskResourcePlan({
        ...BASE,
        resolvedReservationJson: JSON.stringify({ ...base, diagnostics: 'not-an-array' }),
      })
    ).toThrow(/diagnostics must be an array/);

    expect(() =>
      readPersistedTaskResourcePlan({
        ...BASE,
        resolvedReservationJson: JSON.stringify({ ...base, diagnostics: [1] }),
      })
    ).toThrow(/diagnostics\[0\] must be a string/);

    const withBadCompatibility = {
      ...base,
      fieldProvenance: {
        ...base.fieldProvenance,
        minVcpu: {
          ...base.fieldProvenance?.minVcpu,
          compatibility: { adapter: 'legacy-vm-size', version: 1, legacyVmSize: 'gigantic' },
        },
      },
    };
    expect(() =>
      readPersistedTaskResourcePlan({
        ...BASE,
        resolvedReservationJson: JSON.stringify(withBadCompatibility),
      })
    ).toThrow(/compatibility\.legacyVmSize is invalid/);

    const withNonNumericVersion = {
      ...base,
      fieldProvenance: {
        ...base.fieldProvenance,
        minVcpu: {
          ...base.fieldProvenance?.minVcpu,
          compatibility: { adapter: 'legacy-vm-size', version: 'v1', legacyVmSize: 'small' },
        },
      },
    };
    expect(() =>
      readPersistedTaskResourcePlan({
        ...BASE,
        resolvedReservationJson: JSON.stringify(withNonNumericVersion),
      })
    ).toThrow(/compatibility\.version must be a number/);
  });
});
