/**
 * Self-host box, 2026-11-11: a pool whose only machine was Google Cloud e2-medium (2 vCPU,
 * 4 GB) failed every default chat and task, because placement keeps a 1 GB host reserve and a
 * default workspace asks for 4 GB. The admin pool view said nothing.
 */
import { describe, expect, it } from 'vitest';

import { defaultWorkspaceFitWarning } from '../../../src/lib/compute-pool-default-fit';
import type { MachineGroup, MachineTypeRow } from '../../../src/lib/compute-pool-machines';

function row(sku: string, vcpu: number | null, ramGb: number | null, allowed = true) {
  return {
    key: `gcp|${sku}`,
    provider: 'gcp',
    providerLabel: 'Google Cloud',
    sku,
    vcpu,
    ramGb,
    diskGb: 20,
    allowed,
    cells: [{ allowed, locationLabel: 'europe-west1-b' }],
  } as unknown as MachineTypeRow;
}

function pool(...rows: MachineTypeRow[]): MachineGroup[] {
  return [{ key: 'gcp', providerLabel: 'Google Cloud', rows } as unknown as MachineGroup];
}

describe('defaultWorkspaceFitWarning', () => {
  it('warns when the largest allowed machine is 4 GB (e2-medium only)', () => {
    const warning = defaultWorkspaceFitWarning(pool(row('e2-medium', 2, 4)));
    expect(warning).toMatch(/No allowed machine can run a default workspace/);
    expect(warning).toMatch(/at least 5 GB/);
  });

  it('control: no warning once an 8 GB machine is allowed beside it', () => {
    expect(
      defaultWorkspaceFitWarning(pool(row('e2-medium', 2, 4), row('e2-standard-2', 2, 8)))
    ).toBeNull();
  });

  it('ignores machines that are listed but not allowed', () => {
    expect(
      defaultWorkspaceFitWarning(pool(row('e2-medium', 2, 4), row('e2-standard-2', 2, 8, false)))
    ).toMatch(/No allowed machine/);
  });

  it('warns on too few vCPUs even with enough memory', () => {
    expect(defaultWorkspaceFitWarning(pool(row('e2-highmem-1', 1, 16)))).toMatch(
      /No allowed machine/
    );
  });

  it('stays quiet when a machine size is unknown, and when nothing is allowed', () => {
    expect(
      defaultWorkspaceFitWarning(pool(row('e2-medium', 2, 4), row('custom', null, null)))
    ).toBeNull();
    expect(defaultWorkspaceFitWarning(pool(row('e2-medium', 2, 4, false)))).toBeNull();
  });
});
