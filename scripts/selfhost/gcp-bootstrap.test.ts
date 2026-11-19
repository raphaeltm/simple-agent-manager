/**
 * deploy/selfhost/gcp-bootstrap.sh against a fake `gcloud` and `curl` on PATH. The fake keeps
 * Google Cloud state as files, so a second run sees what the first created.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every case runs bash and a node-based fake gcloud many times.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT = resolve(import.meta.dirname, '../../deploy/selfhost/gcp-bootstrap.sh');
const ISSUER = 'https://api.vmtest.example.org';

// The fake keeps Google Cloud state in $STATE/gcp.json and appends every call to $STATE/calls.
const FAKE_GCLOUD = `#!/usr/bin/env bash
exec node ${JSON.stringify(resolve(import.meta.dirname, 'testdata/fake-gcloud-iam.mjs'))} "$@"
`;
const FAKE_CURL = `#!/usr/bin/env bash
printf '{"issuer":"%s","jwks_uri":"%s/.well-known/jwks.json"}' "$FAKE_ISSUER" "$FAKE_ISSUER"
`;

let state: string;
let bin: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'gcp-bootstrap-state-'));
  bin = mkdtempSync(join(tmpdir(), 'gcp-bootstrap-bin-'));
  writeFileSync(join(bin, 'gcloud'), FAKE_GCLOUD);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'gcloud'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
});

function run(args: string[], advertisedIssuer = ISSUER, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      FAKE_ISSUER: advertisedIssuer,
      ...env,
    },
  });
  return { ...result, calls: calls() };
}

interface FakeGcp {
  pools: Record<string, { description: string; state?: string }>;
  providers: Record<string, { issuer: string; state?: string }>;
  accounts: Record<string, { description: string }>;
  bindings: string[];
}

function gcp(): FakeGcp {
  return JSON.parse(readFileSync(join(state, 'gcp.json'), 'utf8')) as FakeGcp;
}

function setGcp(update: (db: FakeGcp) => void): void {
  const db = gcp();
  update(db);
  writeFileSync(join(state, 'gcp.json'), JSON.stringify(db));
}

function calls(): string[] {
  try {
    return readFileSync(join(state, 'calls'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

const MUTATING =
  /^(services enable|iam workload-identity-pools( providers)? create|iam service-accounts create|projects add-iam-policy-binding|iam service-accounts add-iam-policy-binding)/;

describe('pnpm selfhost:gcp-bootstrap', () => {
  it('creates the pool, issuer-scoped provider, service account and bindings, and prints the five form values', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', `${ISSUER}/`]);
    expect(result.status, result.stderr).toBe(0);

    const provider = result.calls.find((c) => c.includes('providers create-oidc'))!;
    expect(provider).toContain(`--issuer-uri=${ISSUER}`);
    expect(provider).toContain(`--attribute-condition=assertion.iss == '${ISSUER}'`);
    expect(provider).toContain(
      '--allowed-audiences=https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/'
    );
    const roles = result.calls.filter((c) => c.startsWith('projects add-iam-policy-binding'));
    expect(roles.map((c) => /--role=(\S+)/.exec(c)?.[1])).toEqual([
      'roles/compute.instanceAdmin.v1',
      'roles/compute.securityAdmin',
    ]);
    const impersonation = result.calls.find((c) =>
      c.startsWith('iam service-accounts add-iam-policy-binding')
    )!;
    expect(impersonation).toContain('--role=roles/iam.workloadIdentityUser');
    expect(impersonation).toMatch(
      /principalSet:\/\/iam\.googleapis\.com\/projects\/123456789012\/locations\/global\/workloadIdentityPools\/sam-[0-9a-f]{8}\/\*/
    );

    // Cloud Billing: the node catalog's GCP list prices (box round R14).
    const services = result.calls.find((c) => c.startsWith('services enable'))!;
    expect(services.split(' ')).toEqual(
      expect.arrayContaining(['compute.googleapis.com', 'cloudbilling.googleapis.com'])
    );

    expect(result.stdout).toMatch(/Project ID:\s+sam-vm-test/);
    expect(result.stdout).toMatch(/Project number:\s+123456789012/);
    expect(result.stdout).toMatch(/Pool ID:\s+sam-[0-9a-f]{8}/);
    expect(result.stdout).toMatch(/Provider ID:\s+sam-api/);
    expect(result.stdout).toMatch(
      /Service account email:\s+sam-nodes@sam-vm-test\.iam\.gserviceaccount\.com/
    );
  });

  // The printed JSON is parsed with the app's own parser in
  // apps/api/tests/unit/selfhost/gcp-bootstrap-credential.test.ts (it needs built packages).
  it('prints where the credential goes in SAM (box round R12)', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Admin -> Credentials -> Add Credential');
    expect(result.stdout).not.toContain('Integrations');
    expect(result.stdout).toMatch(/^\{"version":1,"provider":"gcp".*"defaultZone":"ZONE"\}$/m);
  });

  it('is idempotent: a second run creates nothing new and prints the same values', () => {
    const first = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(first.status, first.stderr).toBe(0);
    const before = calls().length;
    const second = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(second.status, second.stderr).toBe(0);
    const secondCalls = second.calls.slice(before);
    expect(secondCalls.filter((c) => / create/.test(c))).toEqual([]);
    expect(second.stdout.split('Add the installation')[1]).toBe(
      first.stdout.split('Add the installation')[1]
    );
  });

  it('dry run changes nothing and shows what it would run', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((c) => MUTATING.test(c))).toEqual([]);
    expect(result.stdout).toContain('would run: gcloud iam workload-identity-pools create');
    expect(result.stdout).toContain('Dry run: nothing was changed.');
  });

  it('refuses to retarget a provider that already trusts another install', () => {
    run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-shared']);
    const other = 'https://api.other.example.org';
    const result = run(
      ['--project', 'sam-vm-test', '--api-url', other, '--pool-id', 'sam-shared'],
      other
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`already trusts ${ISSUER}`);
    expect(gcp().providers['sam-api'].issuer).toBe(ISSUER);
  });

  it('refuses an install whose discovery document names a different issuer', () => {
    const result = run(
      ['--project', 'sam-vm-test', '--api-url', ISSUER],
      'https://api.elsewhere.org'
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not advertise issuer');
    expect(result.calls.filter((c) => MUTATING.test(c))).toEqual([]);
  });

  it('a soft-deleted pool of the same id: stops with the undelete command, creates nothing (R13 D5)', () => {
    expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
    const pool = Object.keys(gcp().pools)[0] ?? '';
    // Someone deleted it; Google keeps the id, and describe still answers, for 30 days.
    setGcp((db) => {
      const entry = db.pools[pool];
      if (entry) entry.state = 'DELETED';
      delete db.providers['sam-api'];
    });
    const before = calls().length;
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`workload identity pool ${pool} was deleted`);
    expect(result.stderr).toContain(
      `gcloud iam workload-identity-pools undelete ${pool} --project=sam-vm-test --location=global`
    );
    expect(result.stderr).toContain('--pool-id');
    expect(
      result.calls.slice(before).filter((c) => MUTATING.test(c) && !c.startsWith('services'))
    ).toEqual([]);
    expect(gcp().providers).toEqual({});
  });

  it('a soft-deleted provider: stops with its undelete command', () => {
    expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
    setGcp((db) => {
      const entry = db.providers['sam-api'];
      if (entry) entry.state = 'DELETED';
    });
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'gcloud iam workload-identity-pools providers undelete sam-api'
    );
  });

  it('with the install not up yet: says to run it after the deploy', () => {
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 7\n');
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('after `pnpm selfhost:deploy`');
    expect(result.stderr).toContain('--skip-issuer-check');
    expect(result.calls).toEqual([]);
  });

  it('creates only the node trust: no KMS key, VM, bucket or firewall', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((c) => /^(kms|compute|storage)\b/.test(c))).toEqual([]);
    expect(result.stdout).not.toContain('SAM_GCP_KMS_KEY');
  });

  it('refuses an API URL that is not https://api.<domain>', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', "https://app.x.org' || true"]);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});
