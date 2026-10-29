import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  DeviceAuthStateSchema,
  driverFailure,
} from '../../../src/durable-objects/credential-setup-session/driver-state';

describe('setup driver boundary', () => {
  it.each([
    'process_exited',
    'stdin_write_failed',
    'code_read_failed',
    'output_parse_failed',
    'credential_write_failed',
    'code_state_mismatch',
    'exchange_provider_error',
    'exchange_failed',
  ])('retains %s instead of blaming the code', (code) => {
    expect(driverFailure({ status: 'failed', code }).code).toBe(code);
  });
  it('drops unknown metadata and never echoes free-form diagnostics', () => {
    const parsed = v.parse(DeviceAuthStateSchema, {
      status: 'failed',
      code: 'process_exited',
      error: 'secret-code#state',
      detail: 'https://claude.com/oauth?state=private&code=secret',
      diagnostics: {
        cliVersion: '2.1.281',
        exitCode: 1,
        codeReadAt: 123,
        token: 'secret',
        verificationCode: 'secret-code#state',
      },
    });
    expect(parsed.diagnostics).toEqual({ cliVersion: '2.1.281', exitCode: 1, codeReadAt: 123 });
    expect(driverFailure(parsed)).toEqual({
      code: 'process_exited',
      message: 'The Claude sign-in process stopped before returning a token. Please try again.',
    });
  });
  it('invalid metadata does not suppress failure', () => {
    const state = v.parse(DeviceAuthStateSchema, {
      status: 'failed',
      code: 'stdin_write_failed',
      diagnostics: { cliVersion: 'secret-token' },
    });
    expect(state.diagnostics).toEqual({});
    expect(driverFailure(state).code).toBe('stdin_write_failed');
  });
  it('unknown failure codes are not reflected and safe numeric status is retained', () => {
    expect(
      driverFailure({
        status: 'failed',
        code: 'secret-token',
        detail: 'Request failed with status code 503 secret-code#state',
      })
    ).toEqual({
      code: 'setup_failed',
      message: 'Claude Code could not complete sign-in. Please start again. [CLI: HTTP 503]',
    });
  });
});
