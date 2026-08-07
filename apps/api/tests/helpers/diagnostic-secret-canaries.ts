import { expect } from 'vitest';

import canaryFixture from '../../../../tests/fixtures/diagnostic-secret-canaries.json';

export const diagnosticSecretCanaries = canaryFixture.map(({ fragments }) => fragments.join(''));

export function expectDiagnosticCanariesAbsent(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of diagnosticSecretCanaries) expect(serialized).not.toContain(canary);
}
