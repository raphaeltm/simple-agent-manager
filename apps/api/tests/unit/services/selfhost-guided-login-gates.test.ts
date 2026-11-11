/**
 * The self-host config generator (scripts/selfhost/celld-config.ts) writes the vars the API's
 * capability gates read. This drives the real generator over the real wrangler.toml into the real
 * gates, so renaming either side breaks a test (prototype task 01M769WDVM4HCQ7185R8E2QGV6).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import { buildCelldConfig } from '../../../../../scripts/selfhost/celld-config';
import type { Env } from '../../../src/env';
import {
  isContainerWorkspaceRuntimeEnabled,
  isGuidedCredentialSetupAvailable,
} from '../../../src/services/platform-capabilities';

const source = TOML.parse(readFileSync(resolve(__dirname, '../../../wrangler.toml'), 'utf8'));

/** Bindings exist on every deployment: index.ts exports the classes and celld binds them. */
const bindings = { SANDBOX: {}, CREDENTIAL_SETUP_SESSION: {}, SETUP_SESSION_POOL: {} };

function gates(guidedLogin: { runtime: string; instanceType: string } | null) {
  const { vars } = buildCelldConfig(source as never, {
    main: 'src/index.ts',
    baseDomain: 'sam.example.com',
    guidedLogin,
  }).config;
  // An operator re-enabling the Instant switch in secrets.env must not turn Instant on.
  const env = { ...bindings, ...vars, CF_CONTAINER_ENABLED: 'true' } as unknown as Env;
  return {
    guided: isGuidedCredentialSetupAvailable(env),
    instant: isContainerWorkspaceRuntimeEnabled(env),
  };
}

describe('self-host generated vars drive the capability gates', () => {
  it('guided login on: guided setup offered, Instant not', () => {
    expect(gates({ runtime: 'runsc', instanceType: 'basic' })).toEqual({
      guided: true,
      instant: false,
    });
  });

  it('guided login off (default): neither', () => {
    expect(gates(null)).toEqual({ guided: false, instant: false });
  });
});
