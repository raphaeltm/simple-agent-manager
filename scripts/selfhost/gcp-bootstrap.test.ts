/**
 * deploy/selfhost/gcp-bootstrap.sh against a fake `gcloud` and `curl` on PATH. The fake keeps
 * Google Cloud state as files, so a second run sees what the first created.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const result = spawnSync('bash', [SCRIPT, ...args, '--state-dir', join(state, 'box-state')], {
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
  pools: Record<string, { description: string }>;
  providers: Record<string, { issuer: string }>;
  accounts: Record<string, { description: string }>;
  bindings: string[];
  rings: Record<string, object>;
  keys: Record<string, { labels: Record<string, string>; versions: Record<string, string> }>;
}

function gcp(): FakeGcp {
  return JSON.parse(readFileSync(join(state, 'gcp.json'), 'utf8')) as FakeGcp;
}

function setGcp(update: (db: FakeGcp) => void): void {
  const db = gcp();
  update(db);
  writeFileSync(join(state, 'gcp.json'), JSON.stringify(db));
}

function record(): { resources: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(state, 'box-state/created-resources.json'), 'utf8')) as {
    resources: Array<Record<string, unknown>>;
  };
}

function calls(): string[] {
  try {
    return readFileSync(join(state, 'calls'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

const MUTATING =
  /^(services enable|iam workload-identity-pools( providers)? (create|delete)|iam service-accounts (create|delete)|projects (add|remove)-iam-policy-binding|iam service-accounts add-iam-policy-binding|kms (keyrings|keys) (create|delete|add-iam-policy-binding|remove-iam-policy-binding)|kms keys versions (destroy|delete))/;

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

    expect(result.stdout).toMatch(/Project ID:\s+sam-vm-test/);
    expect(result.stdout).toMatch(/Project number:\s+123456789012/);
    expect(result.stdout).toMatch(/Pool ID:\s+sam-[0-9a-f]{8}/);
    expect(result.stdout).toMatch(/Provider ID:\s+sam-api/);
    expect(result.stdout).toMatch(
      /Service account email:\s+sam-nodes@sam-vm-test\.iam\.gserviceaccount\.com/
    );
  });

  it('is idempotent: a second run creates nothing new and prints the same values', () => {
    const first = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(first.status, first.stderr).toBe(0);
    const before = calls().length;
    const second = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(second.status, second.stderr).toBe(0);
    const secondCalls = second.calls.slice(before);
    expect(secondCalls.filter((c) => / create/.test(c))).toEqual([]);
    expect(second.stdout.split('Enter these')[1]).toBe(first.stdout.split('Enter these')[1]);
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

  it('refuses an API URL that is not https://api.<domain>', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', "https://app.x.org' || true"]);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});

const BOX_SA = 'sam-box@sam-vm-test.iam.gserviceaccount.com';
const KEY_PATH = (key: string) => `sam-selfhost/${key}`;
const kmsArgs = [
  '--project',
  'sam-vm-test',
  '--api-url',
  ISSUER,
  '--kms',
  '--box-service-account',
  BOX_SA,
];

function keyName(): string {
  const key = Object.keys(gcp().keys)[0] ?? '';
  return key.split('/')[1] ?? '';
}

describe('--kms: the sealed-secrets key', () => {
  it('creates a labelled key, grants the box encrypt/decrypt on that key only, prints the reference', () => {
    const result = run(kmsArgs);
    expect(result.status, result.stderr).toBe(0);
    const key = keyName();
    expect(key).toMatch(/^sam-[0-9a-f]{8}$/);
    // Same derivation as the pool id: the install's name, which --init looks for by default.
    expect(key).toBe(Object.keys(gcp().pools)[0]);
    expect(gcp().keys[KEY_PATH(key)]?.labels).toEqual({ 'sam-install': key.slice(4) });
    const kmsGrants = gcp().bindings.filter((b) => b.startsWith('key:'));
    expect(kmsGrants).toEqual([
      `key:${KEY_PATH(key)} roles/cloudkms.cryptoKeyEncrypterDecrypter serviceAccount:${BOX_SA}`,
    ]);
    // No ring- or project-level KMS grant.
    expect(gcp().bindings.filter((b) => b.includes('cloudkms') && !b.startsWith('key:'))).toEqual(
      []
    );
    expect(result.stdout).toContain(
      `SAM_GCP_KMS_KEY=projects/sam-vm-test/locations/global/keyRings/sam-selfhost/cryptoKeys/${key}`
    );
  });

  it('records what it created, provider-neutral, with no secret, and is idempotent', () => {
    expect(run(kmsArgs).status).toBe(0);
    const first = record();
    expect(first).toMatchObject({ format: 'sam-created-resources/1' });
    const kinds = first.resources.map((r) => `${String(r.kind)}:${String(r.action)}`).sort();
    expect(kinds).toEqual([
      'iam-binding:created',
      'iam-binding:created',
      'iam-binding:created',
      'kms-key-ring:created',
      'kms-key:created',
      'service-account:created',
      'workload-identity-pool:created',
      'workload-identity-provider:created',
    ]);
    for (const r of first.resources) {
      expect(Object.keys(r).sort()).toEqual(
        ['action', 'attributes', 'cloud', 'createdAt', 'createdBy', 'kind', 'name'].sort()
      );
      expect(r).toMatchObject({ cloud: 'gcp', createdBy: 'gcp-bootstrap' });
    }
    const before = calls().length;
    const again = run(kmsArgs);
    expect(again.status, again.stderr).toBe(0);
    expect(again.calls.slice(before).filter((c) => / create/.test(c))).toEqual([]);
    // A second run never downgrades "created" to "reused".
    expect(record().resources.map((r) => r.action)).toEqual(first.resources.map((r) => r.action));
  });

  it('dry run changes nothing and writes no record', () => {
    const result = run([...kmsArgs, '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((c) => MUTATING.test(c))).toEqual([]);
    expect(result.stdout).toContain('would run: gcloud kms keys create');
    expect(existsSync(join(state, 'box-state/created-resources.json'))).toBe(false);
  });

  it('reads the box identity from the VM and warns when its scopes cannot reach Cloud KMS', () => {
    const result = run(
      [
        '--project',
        'sam-vm-test',
        '--api-url',
        ISSUER,
        '--kms-only',
        '--box-instance',
        'sam-box',
        '--box-zone',
        'europe-west1-b',
      ],
      ISSUER,
      {
        FAKE_BOX_SA: BOX_SA,
        FAKE_BOX_SCOPES: 'https://www.googleapis.com/auth/devstorage.read_write',
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('access scopes allow neither cloud-platform nor cloudkms');
    expect(gcp().bindings).toEqual([
      `key:${KEY_PATH(keyName())} roles/cloudkms.cryptoKeyEncrypterDecrypter serviceAccount:${BOX_SA}`,
    ]);
    // --kms-only: no pool, provider or node service account.
    expect(gcp().pools).toEqual({});
    expect(gcp().accounts).toEqual({});
  });

  it("refuses to use a key with that name that is not this install's", () => {
    expect(run(kmsArgs).status).toBe(0);
    const key = keyName();
    setGcp((db) => {
      const entry = db.keys[KEY_PATH(key)];
      if (entry) entry.labels = { 'sam-install': 'deadbeef' };
    });
    const result = run(kmsArgs);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not labelled sam-install=');
  });
});

describe('--teardown', () => {
  it('removes exactly what it created; the key stays until its versions are explicitly destroyed', () => {
    // Something this bootstrap did not create, in the same project: must survive.
    expect(run(kmsArgs).status).toBe(0);
    const key = keyName();
    setGcp((db) => {
      db.accounts['other@sam-vm-test.iam.gserviceaccount.com'] = { description: 'someone else' };
      db.bindings.push(
        'project:sam-vm-test roles/viewer serviceAccount:other@sam-vm-test.iam.gserviceaccount.com'
      );
    });
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--teardown']);
    expect(result.status, result.stderr).toBe(0);
    const db = gcp();
    expect(db.pools).toEqual({});
    expect(db.providers).toEqual({});
    expect(Object.keys(db.accounts)).toEqual(['other@sam-vm-test.iam.gserviceaccount.com']);
    expect(db.bindings).toEqual([
      'project:sam-vm-test roles/viewer serviceAccount:other@sam-vm-test.iam.gserviceaccount.com',
    ]);
    // Grant gone at once; the key and its version kept, and said so with the consequence.
    expect(db.keys[KEY_PATH(key)]?.versions).toEqual({ 1: 'ENABLED' });
    expect(result.stdout).toContain('unrecoverable');
    expect(result.stdout).toContain(`--destroy-key-versions ${key}`);
    expect(
      record()
        .resources.filter((r) => !r.removedAt)
        .map((r) => r.kind)
        .sort()
    ).toEqual(['kms-key', 'kms-key-ring']);
  });

  it('with --destroy-key-versions: schedules destruction, then a later run deletes key and ring', () => {
    expect(
      run([...kmsArgs.slice(0, 5), '--kms-only', '--box-service-account', BOX_SA]).status
    ).toBe(0);
    const key = keyName();
    const wrong = run([
      '--project',
      'sam-vm-test',
      '--api-url',
      ISSUER,
      '--teardown',
      '--destroy-key-versions',
      'not-this-key',
    ]);
    expect(wrong.status).toBe(0);
    expect(gcp().keys[KEY_PATH(key)]?.versions).toEqual({ 1: 'ENABLED' });

    const first = run([
      '--project',
      'sam-vm-test',
      '--api-url',
      ISSUER,
      '--teardown',
      '--destroy-key-versions',
      key,
    ]);
    expect(first.status, first.stderr).toBe(0);
    expect(gcp().keys[KEY_PATH(key)]?.versions).toEqual({ 1: 'DESTROY_SCHEDULED' });
    expect(first.stdout).toContain('scheduled for destruction');
    expect(first.stdout).toContain('gcloud kms keys versions restore');

    // 30 days later Google has destroyed the version.
    setGcp((db) => {
      const entry = db.keys[KEY_PATH(key)];
      if (entry) entry.versions = { 1: 'DESTROYED' };
    });
    const second = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--teardown']);
    expect(second.status, second.stderr).toBe(0);
    expect(gcp().keys).toEqual({});
    expect(gcp().rings).toEqual({});
    expect(record().resources.every((r) => typeof r.removedAt === 'string')).toBe(true);
  });

  it('refuses what fails its ownership proof, and leaves what existed before', () => {
    // The node service account existed before the bootstrap: it is recorded as reused.
    writeFileSync(
      join(state, 'gcp.json'),
      JSON.stringify({
        pools: {},
        providers: {},
        accounts: { 'sam-nodes@sam-vm-test.iam.gserviceaccount.com': { description: 'shared' } },
        bindings: [],
        rings: {},
        keys: {},
      })
    );
    expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
    // Someone rewrote the pool's description after creation: no proof it is this install's.
    setGcp((db) => {
      for (const pool of Object.values(db.pools)) pool.description = 'renamed by hand';
    });
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--teardown']);
    expect(result.status, result.stderr).toBe(0);
    const db = gcp();
    expect(Object.keys(db.pools)).toHaveLength(1);
    expect(Object.keys(db.accounts)).toEqual(['sam-nodes@sam-vm-test.iam.gserviceaccount.com']);
    // Its project roles stay too: the account is shared, the roles are not this install's alone.
    expect(db.bindings.filter((b) => b.startsWith('project:'))).toHaveLength(2);
    expect(result.stdout).toMatch(/pool .*does not name .*; refused/);
    expect(result.stdout).toContain('existed before the bootstrap; kept');
  });

  it('dry run removes nothing and keeps the record as it was', () => {
    expect(run(kmsArgs).status).toBe(0);
    const before = JSON.stringify(gcp());
    const recorded = JSON.stringify(record());
    const n = calls().length;
    const result = run([
      '--project',
      'sam-vm-test',
      '--api-url',
      ISSUER,
      '--teardown',
      '--dry-run',
      '--destroy-key-versions',
      keyName(),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.stringify(gcp())).toBe(before);
    expect(JSON.stringify(record())).toBe(recorded);
    expect(result.calls.slice(n).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(result.stdout).toContain('would run: gcloud iam workload-identity-pools delete');
    expect(result.stdout).toContain('would run: gcloud kms keys versions destroy');
  });

  it('without a record, refuses rather than guess', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--teardown']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('removes only what it recorded creating');
    expect(result.calls.filter((c) => MUTATING.test(c))).toEqual([]);
  });
});
