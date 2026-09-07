import { describe, expect, it } from 'vitest';

import { getRuntimeValidationError } from '../../../src/routes/mcp/dispatch-instant';
import { parseDispatchTaskParams } from '../../../src/routes/mcp/dispatch-tool-params';

const limits = {
  dispatchDescriptionMaxLength: 1000,
  dispatchMaxPriority: 10,
  dispatchMaxReferences: 5,
  dispatchMaxReferenceLength: 200,
};

describe('MCP dispatch_task resource requirements input', () => {
  it('preserves modern fields, explicit false, and legacy vmSize together', () => {
    const result = parseDispatchTaskParams(
      1,
      {
        description: 'Run explicit hardware',
        vmSize: 'small',
        resourceRequirements: { minVcpu: 4, minMemoryGb: 16, exclusiveNode: false },
      },
      limits
    );

    expect('parsed' in result).toBe(true);
    if (!('parsed' in result)) return;
    expect(result.parsed.vmSize).toBe('small');
    expect(result.parsed.resourceRequirements).toEqual({
      minVcpu: 4,
      minMemoryGb: 16,
      exclusiveNode: false,
    });
  });

  it('allows omitted resourceRequirements and rejects null task constraints', () => {
    const omitted = parseDispatchTaskParams(1, { description: 'Run default hardware' }, limits);
    expect('parsed' in omitted).toBe(true);
    if ('parsed' in omitted) expect(omitted.parsed.resourceRequirements).toBeUndefined();

    const nulled = parseDispatchTaskParams(
      1,
      { description: 'Run explicit hardware', resourceRequirements: null },
      limits
    );
    expect('error' in nulled).toBe(true);
    if ('error' in nulled) expect(nulled.error.error?.code).toBe(-32602);
  });

  it('rejects negative, non-finite, and malformed known fields', () => {
    for (const resourceRequirements of [
      { minVcpu: -1 },
      { minVcpu: 0 },
      { minMemoryGb: Number.NaN },
      { minDiskGb: Number.POSITIVE_INFINITY },
      { exclusiveNode: 'false' },
      { maxCoTenants: 0 },
      { maxCoTenants: 1.5 },
      [],
    ]) {
      const result = parseDispatchTaskParams(
        1,
        {
          description: 'Run explicit hardware',
          resourceRequirements,
        },
        limits
      );

      expect('error' in result).toBe(true);
      if ('error' in result) expect(result.error.error?.code).toBe(-32602);
    }
  });

  it('treats resourceRequirements as VM-only for container runtime validation', () => {
    expect(
      getRuntimeValidationError(
        { runtime: 'cf-container', resourceRequirements: { minVcpu: 2 } },
        'cf-container'
      )
    ).toContain('VM-only fields: resourceRequirements');
  });
});
