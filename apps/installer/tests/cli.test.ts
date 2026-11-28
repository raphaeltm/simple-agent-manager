import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Runs the real command runner. Every case stops in readTarget, before any network call.
const cli = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url));
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 20_000,
  });
}
describe('installer command runner', () => {
  it.each([[[]], [['bogus']]])('prints usage and exits 2 for %j', (args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage: node scripts/cli.mjs <deploy|remove|check-live>');
    expect(result.stdout).toBe('');
  });
  it.each(['deploy', 'remove', 'check-live'])(
    '%s without credentials fails with one plain message and no stack trace',
    (command) => {
      const result = run([command]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Set CLOUDFLARE_API_TOKEN and a valid CLOUDFLARE_ACCOUNT_ID.'
      );
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(result.stdout).toBe('');
    }
  );
  it('never echoes the token in a failure', () => {
    const result = run(['remove'], {
      CLOUDFLARE_API_TOKEN: 'TOKEN_THAT_MUST_NOT_APPEAR',
      CLOUDFLARE_ACCOUNT_ID: 'not-an-account',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(result.stdout + result.stderr).not.toContain('TOKEN_THAT_MUST_NOT_APPEAR');
  });
});
