import { expect } from 'vitest';

import canaryFixture from '../../../../tests/fixtures/diagnostic-secret-canaries.json';

function fixtureCanary(name: string): string {
  const entry = canaryFixture.find((canary) => canary.name === name);
  if (!entry) throw new Error(`diagnostic canary fixture has no entry named "${name}"`);
  return entry.fragments.join('');
}

/**
 * Realistic credential tokens that every API redactor must strip
 * (`src/lib/credential-token-redaction.ts`), assembled from fragments so the repository never holds
 * a literal key. The provider and GitHub shapes come from the canary fixture the VM agent's Go
 * redactor also consumes; SAM's own PAT is API-only because the Go redactor has no SAM token shape.
 * The SAM PAT carries a `-` on purpose: the logger's old `sam_[A-Za-z0-9_]*` stopped there.
 */
export const credentialTokenCanaries = {
  openaiLegacyKey: fixtureCanary('openai-legacy-key'),
  openaiProjectKey: fixtureCanary('openai-project-key'),
  anthropicApiKey: fixtureCanary('anthropic-api-key'),
  githubFineGrainedPat: fixtureCanary('github-fine-grained-pat'),
  samPersonalAccessToken: ['sam_', 'pat_', 'q7Hk2Zx9Lm4P-w8Rt6Vb3Nc1Yd5_Fg0JuE2rT'].join(''),
} as const;

export const allCredentialTokenCanaries: readonly string[] = Object.values(credentialTokenCanaries);

/**
 * Asserts that neither a canary nor its tail survives. The tail matters: a redactor that stops
 * early (the logger's old `sam_[A-Za-z0-9_]*` halted at a `-`) removes the full string while
 * leaking most of the token.
 */
export function expectCredentialTokensAbsent(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of allCredentialTokenCanaries) {
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(canary.slice(-12));
  }
}
