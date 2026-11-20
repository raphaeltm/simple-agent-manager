/**
 * `pnpm selfhost:gcp-bootstrap` (deploy/selfhost/gcp-bootstrap.sh) prints the platform cloud
 * credential an operator pastes into Admin -> Credentials. This runs the script against the fake
 * `gcloud` its own tests use (scripts/selfhost/gcp-bootstrap.test.ts) and parses the printed JSON
 * with the parser the app uses for every node (parseGcpCredential), so a change on either side
 * fails here. It lives with the API unit tests because the parser imports workspace packages
 * through their built dist/, which the API unit suite builds and the self-host packaging tests do
 * not need.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseGcpCredential } from '../../../src/services/provider-credential-codecs';

const SCRIPT = resolve(import.meta.dirname, '../../../../../deploy/selfhost/gcp-bootstrap.sh');
const FAKE_GCLOUD_IAM = resolve(
  import.meta.dirname,
  '../../../../../scripts/selfhost/testdata/fake-gcloud-iam.mjs'
);
const ISSUER = 'https://api.vmtest.example.org';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gcp-bootstrap-credential-'));
  writeFileSync(
    join(dir, 'gcloud'),
    `#!/usr/bin/env bash\nexec node ${JSON.stringify(FAKE_GCLOUD_IAM)} "$@"\n`
  );
  writeFileSync(
    join(dir, 'curl'),
    `#!/usr/bin/env bash\nprintf '{"issuer":"%s"}' ${JSON.stringify(ISSUER)}\n`
  );
  chmodSync(join(dir, 'gcloud'), 0o755);
  chmodSync(join(dir, 'curl'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gcp-bootstrap.sh output', () => {
  it('prints JSON the credential parser accepts once ZONE is filled in (box round R12)', () => {
    const result = spawnSync('bash', [SCRIPT, '--project', 'sam-vm-test', '--api-url', ISSUER], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH ?? ''}`, STATE: dir, HOME: dir },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const json = /^\{"version":1,"provider":"gcp".*\}$/m.exec(result.stdout)?.[0];
    expect(json).toBeDefined();
    // The operator replaces ZONE; the result is what the app stores and parses for every node.
    const parsed = parseGcpCredential(json!.replace('"ZONE"', '"europe-west1-b"'));
    expect(parsed).toMatchObject({
      authType: 'workload-identity',
      gcpProjectId: 'sam-vm-test',
      gcpProjectNumber: '123456789012',
      serviceAccountEmail: 'sam-nodes@sam-vm-test.iam.gserviceaccount.com',
      wifProviderId: 'sam-api',
      defaultZone: 'europe-west1-b',
    });
    expect(parsed.authType === 'workload-identity' && parsed.wifPoolId).toMatch(
      /^sam-[0-9a-f]{8}$/
    );
  });
});
