import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Run the real deployment script against a strict, isolated REST transport. */
function configureCors(rejectRequest = false) {
  const fixture = mkdtempSync(join(tmpdir(), 'sam-r2-cors-'));
  try {
    const bin = join(fixture, 'bin');
    mkdirSync(bin);
    // Strict REST peer: execute the real Bash script and validate its actual
    // outgoing JSON, rather than inspecting its source or substituting a payload.
    writeFileSync(
      join(bin, 'curl'),
      `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { deepStrictEqual } = require('node:assert');
const args = process.argv.slice(2);
let accepted = false;
try {
  deepStrictEqual(JSON.parse(args[args.indexOf('-d') + 1]), {
    rules: [{
      allowed: { origins: ['https://app.fixture.example'], methods: ['PUT'], headers: ['*'] },
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    }],
  });
  accepted = process.env.FIXTURE_REJECT !== '1';
} catch {}
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ success: accepted }));
process.stdout.write(accepted ? '200' : '400');
`,
      { mode: 0o700 }
    );
    return spawnSync('bash', [join(ROOT, 'scripts/deploy/configure-r2-cors.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CF_API_TOKEN: 'synthetic-test-token',
        CF_ACCOUNT_ID: 'synthetic-account',
        R2_BUCKET_NAME: 'synthetic-assets',
        BASE_DOMAIN: 'fixture.example',
        FIXTURE_REJECT: rejectRequest ? '1' : '0',
      },
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('R2 CORS deployment REST contract', () => {
  it('succeeds when the actual request uses the documented REST schema and upload policy', () => {
    const result = configureCors();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('configured successfully (HTTP 200)');
  });

  it('fails deployment when Cloudflare rejects the request with HTTP 400', () => {
    const result = configureCors(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Failed to configure R2 CORS (HTTP 400)');
    expect(result.stdout).not.toContain('configured successfully');
  });
});
