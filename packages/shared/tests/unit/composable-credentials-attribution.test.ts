import { describe, expect, it } from 'vitest';

import {
  credentialOwnerFromSource,
  credentialScopeFromSource,
} from '../../src/composable-credentials/attribution';
import type { ResolutionSource } from '../../src/composable-credentials/types';

const SOURCES: ResolutionSource[] = [
  'run-override',
  'profile-attachment',
  'project-attachment',
  'user-attachment',
  'platform',
  'platform-proxy',
];

describe('credential attribution mappers', () => {
  it('a profile pin is the user’s own credential, chosen at the profile tier', () => {
    expect(credentialOwnerFromSource('profile-attachment')).toBe('user');
    expect(credentialScopeFromSource('profile-attachment')).toBe('profile');
  });

  it('an account chosen for one run is the user’s own credential, at the run tier', () => {
    expect(credentialOwnerFromSource('run-override')).toBe('user');
    expect(credentialScopeFromSource('run-override')).toBe('run');
  });

  it('maps every resolution source; only platform sources report platform', () => {
    expect(SOURCES.map((source) => [source, credentialOwnerFromSource(source)])).toEqual([
      ['run-override', 'user'],
      ['profile-attachment', 'user'],
      ['project-attachment', 'project'],
      ['user-attachment', 'user'],
      ['platform', 'platform'],
      ['platform-proxy', 'platform'],
    ]);
    expect(SOURCES.map((source) => credentialScopeFromSource(source))).toEqual([
      'run',
      'profile',
      'project',
      'user',
      'platform',
      'platform',
    ]);
  });
});
