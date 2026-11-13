/**
 * Review V1 M2 on #2705: rotating ENCRYPTION_KEY pins BETTER_AUTH_SECRET to the old value when
 * it was unset (the Worker fell back to ENCRYPTION_KEY), so after a leak the leaked value would
 * keep signing every session. `rotate encryption-key` therefore chains better-auth-secret, the
 * plan says so, and the summary refuses to call the encryption key retired until that step is
 * done. The end-to-end run is in rotate-command.test.ts ('rotate encryption-key').
 */
import { describe, expect, it } from 'vitest';

import { rotatableKey } from '../../../../../scripts/selfhost/rotate-catalog';
import { formatPlan, formatSummary } from '../../../../../scripts/selfhost/rotate-report';
import { selectKeys } from '../../../../../scripts/selfhost/rotate-run';
import { type Journal,JOURNAL_FORMAT } from '../../../../../scripts/selfhost/rotate-store';

const BASE = { ENCRYPTION_KEY: 'enc-old' };

function names(bundle: Record<string, string>, keys: string[]): string[] {
  return selectKeys({ names: keys, all: false }, bundle).map((k) => k.name);
}

function journal(signIn: 'done' | 'rolled-back' | 'blocked'): Journal {
  return {
    format: JOURNAL_FORMAT,
    id: 'r1',
    startedAt: '2026-11-13T00:00:00.000Z',
    backupDir: null,
    keys: ['encryption-key', 'better-auth-secret'],
    steps: {
      'encryption-key': { name: 'encryption-key', phase: 'done', signInSecretPinned: true },
      'better-auth-secret': { name: 'better-auth-secret', phase: signIn },
    },
    finishedAt: signIn === 'blocked' ? undefined : '2026-11-13T06:00:00.000Z',
  } as Journal;
}

describe('rotate encryption-key and the sign-in secret', () => {
  it('chains better-auth-secret when BETTER_AUTH_SECRET is unset or holds the same value', () => {
    expect(names(BASE, ['encryption-key'])).toEqual(['encryption-key', 'better-auth-secret']);
    expect(names({ ...BASE, BETTER_AUTH_SECRET: 'enc-old' }, ['encryption-key'])).toEqual([
      'encryption-key',
      'better-auth-secret',
    ]);
  });

  it('does not chain when the sign-in secret is already its own value (control)', () => {
    expect(names({ ...BASE, BETTER_AUTH_SECRET: 'separate' }, ['encryption-key'])).toEqual([
      'encryption-key',
    ]);
    // Other keys never chain it.
    expect(names({ ...BASE, PREVIEW_SIGNING_KEY: 'p' }, ['preview-signing-key'])).toEqual([
      'preview-signing-key',
    ]);
  });

  it('the plan says the old value signs sessions until the chained step replaces it', () => {
    const keys = selectKeys({ names: ['encryption-key'], all: false }, BASE);
    const plan = formatPlan(keys, BASE, {}).join('\n');
    expect(plan).toContain('2. better-auth-secret');
    expect(plan).toMatch(/session cookies are signed with it/);
    expect(plan).toMatch(/every user signs in again once/);
    const distinct = { ...BASE, BETTER_AUTH_SECRET: 'separate' };
    expect(formatPlan([rotatableKey('encryption-key')!], distinct, {}).join('\n')).not.toMatch(
      /session cookies are signed with it/
    );
  });

  it('the summary refuses to call the encryption key retired while it still signs sessions', () => {
    for (const phase of ['rolled-back', 'blocked'] as const) {
      const text = formatSummary(journal(phase), BASE, '/state').join('\n');
      expect(text, phase).toMatch(/encryption-key: done; NOT retired: the old value still signs/);
      expect(text, phase).not.toMatch(/Old copies of encryption-key/);
    }
    // Control: once better-auth-secret is done the warning is gone and the key counts as replaced.
    const done = formatSummary(journal('done'), BASE, '/state').join('\n');
    expect(done).not.toMatch(/NOT retired/);
    expect(done).toMatch(/Old copies of encryption-key, better-auth-secret/);
  });
});
