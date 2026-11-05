import { describe, expect, it } from 'vitest';

import type { MapMachine } from '../../../../src/components/account-map/connections-model';
import { machineState } from '../../../../src/components/account-map/connections-parts';

const machine = (status: string, health: string | null): MapMachine => ({
  id: 'n',
  placeholder: false,
  name: 'n',
  provider: 'hetzner',
  size: 'cx43',
  location: 'fsn1',
  status,
  health,
  workspaces: [],
});

describe('machineState', () => {
  it('reads a sleeping or stopped machine by its lifecycle, not its missing heartbeat', () => {
    expect(machineState(machine('sleeping', 'unhealthy'))).toEqual({
      label: 'Asleep',
      tone: 'muted',
    });
    expect(machineState(machine('stopped', 'unhealthy'))).toEqual({
      label: 'Stopped',
      tone: 'muted',
    });
    expect(machineState(machine('stopping', 'unhealthy')).tone).toBe('muted');
  });

  it('calls a machine that should be up but is unhealthy "Not responding"', () => {
    expect(machineState(machine('running', 'unhealthy'))).toEqual({
      label: 'Not responding',
      tone: 'danger',
    });
    expect(machineState(machine('running', 'healthy'))).toEqual({
      label: 'Running',
      tone: 'success',
    });
  });
});
