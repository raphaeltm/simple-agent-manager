/**
 * deploy/selfhost/gcp-bootstrap.sh against a fake `gcloud` and `curl` on PATH. The fake keeps
 * Google Cloud state as files, so a second run sees what the first created.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GCP_REQUIRED_APIS } from '../../packages/shared/src/constants/gcp-required-apis';

// Every case runs bash and a node-based fake gcloud many times.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT = resolve(import.meta.dirname, '../../deploy/selfhost/gcp-bootstrap.sh');
const ISSUER = 'https://api.vmtest.example.org';
// Platform tokens only: SAM signs user_id = platform:<userId> for the installation's credential
// and the bare owner id for a user's (gcpIdentityTokenUserId, apps/api/src/services/gcp-sts.ts).
const CONDITION = `assertion.iss == '${ISSUER}' && assertion.user_id.startsWith('platform:')`;

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
  pools: Record<string, { description: string; state?: string; disabled?: boolean }>;
  providers: Record<
    string,
    {
      issuer: string;
      pool?: string;
      state?: string;
      condition?: string;
      audience?: string;
      disabled?: boolean;
    }
  >;
  accounts: Record<string, { description: string; disabled?: boolean }>;
  bindings: string[];
  saBindings?: Record<string, string[]>;
  saExtraBindings?: Record<string, { role: string; members: string[]; condition?: object }[]>;
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
  /^(services enable|iam workload-identity-pools( providers)? (create|update)|iam service-accounts create|projects add-iam-policy-binding|iam service-accounts add-iam-policy-binding)/;

describe('pnpm selfhost:gcp-bootstrap', () => {
  it('creates the pool, issuer-scoped provider, service account and bindings, and prints the five form values', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', `${ISSUER}/`]);
    expect(result.status, result.stderr).toBe(0);

    const provider = result.calls.find((c) => c.includes('providers create-oidc'))!;
    expect(provider).toContain(`--issuer-uri=${ISSUER}`);
    expect(provider).toContain(`--attribute-condition=${CONDITION}`);
    expect(gcp().providers['sam-api'].condition).toBe(CONDITION);
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
    expect(secondCalls.filter((c) => / (create|update)/.test(c))).toEqual([]);
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

  describe('a provider made by an earlier version (issuer-only condition)', () => {
    const narrow = (extra: string[] = []) => {
      expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
      setGcp((db) => {
        db.providers['sam-api'].condition = `assertion.iss == '${ISSUER}'`;
      });
      return run(['--project', 'sam-vm-test', '--api-url', ISSUER, ...extra]);
    };

    it('is narrowed to platform tokens on the next run', () => {
      const result = narrow();
      expect(result.status, result.stderr).toBe(0);
      expect(gcp().providers['sam-api'].condition).toBe(CONDITION);
      expect(result.calls.filter((c) => c.includes('providers update-oidc'))).toHaveLength(1);
    });

    it('a hand-edited audience is set back, with the condition', () => {
      expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
      const audience = gcp().providers['sam-api'].audience;
      setGcp((db) => {
        db.providers['sam-api'].audience = 'https://example.com/other';
      });
      const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
      expect(result.status, result.stderr).toBe(0);
      expect(gcp().providers['sam-api'].audience).toBe(audience);
      expect(gcp().providers['sam-api'].condition).toBe(CONDITION);
    });

    it('dry run only shows the update', () => {
      const result = narrow(['--dry-run']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        'would run: gcloud iam workload-identity-pools providers update-oidc'
      );
      expect(gcp().providers['sam-api'].condition).toBe(`assertion.iss == '${ISSUER}'`);
    });
  });

  it('a disabled pool (state still ACTIVE): stops with the enable command, binds nothing', () => {
    expect(
      run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-off']).status
    ).toBe(0);
    setGcp((db) => {
      db.pools['sam-off'].disabled = true;
    });
    const before = calls().length;
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-off']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('workload identity pool sam-off is disabled');
    expect(result.stderr).toContain('--no-disabled');
    // API enablement runs first and is idempotent; nothing in IAM changes.
    expect(
      result.calls.slice(before).filter((c) => MUTATING.test(c) && !c.startsWith('services enable'))
    ).toEqual([]);
  });

  it('a disabled provider: stops with the enable command, binds nothing', () => {
    expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
    setGcp((db) => {
      db.providers['sam-api'].disabled = true;
    });
    const before = calls().length;
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/provider sam-[0-9a-f]{8}\/sam-api is disabled/);
    // API enablement runs first and is idempotent; nothing in IAM changes.
    expect(
      result.calls.slice(before).filter((c) => MUTATING.test(c) && !c.startsWith('services enable'))
    ).toEqual([]);
  });

  // add-iam-policy-binding only adds a member: moving to a new --pool-id would leave the old
  // pool's principalSet able to impersonate the reused node account.
  it('a new --pool-id with the old pool still bound: stops with the remove command, binds nothing', () => {
    expect(
      run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-old']).status
    ).toBe(0);
    const before = calls().length;
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-new']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('workloadIdentityPools/sam-old/*');
    expect(result.stderr).toContain('remove-iam-policy-binding');
    // Nothing is granted before the refusal: neither the impersonation binding nor the node's
    // project roles, which the stray member could otherwise use at once.
    expect(
      result.calls
        .slice(before)
        .filter((c) => /^(iam service-accounts|projects) add-iam-policy-binding/.test(c))
    ).toEqual([]);
  });

  describe('a reused node account with other grants on it', () => {
    const SA = 'sam-nodes@sam-vm-test.iam.gserviceaccount.com';
    const grants = (calls: string[]) =>
      calls.filter((c) => /^(iam service-accounts|projects) add-iam-policy-binding/.test(c));
    const rerun = (setup: (db: FakeGcp) => void, env: NodeJS.ProcessEnv = {}) => {
      expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
      setGcp(setup);
      const before = calls().length;
      const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER], ISSUER, env);
      return { ...result, after: result.calls.slice(before) };
    };

    // Any role on the account lets its member act as it (token creator, account user, ...).
    it('refuses serviceAccountTokenCreator held by someone else, granting nothing', () => {
      const result = rerun((db) => {
        db.saExtraBindings = {
          [SA]: [
            { role: 'roles/iam.serviceAccountTokenCreator', members: ['user:mallory@example.com'] },
          ],
        };
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'grants roles/iam.serviceAccountTokenCreator to user:mallory@example.com'
      );
      expect(grants(result.after)).toEqual([]);
    });

    it('refuses a conditional binding, granting nothing', () => {
      const result = rerun((db) => {
        db.saExtraBindings = {
          [SA]: [
            {
              role: 'roles/iam.serviceAccountUser',
              members: ['group:ops@example.com'],
              condition: { title: 'weekdays', expression: 'request.time.getDayOfWeek() < 5' },
            },
          ],
        };
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('has a conditional IAM binding');
      expect(grants(result.after)).toEqual([]);
    });

    // A policy read that yields nothing usable must not read as "no other members".
    it.each(['', 'not json', '[]', '{"bindings": "x"}'])(
      'refuses unparseable policy output %j, granting nothing',
      (raw) => {
        const result = rerun(() => {}, { FAKE_GCLOUD_POLICY_RAW: raw });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('could not parse the IAM policy');
        expect(grants(result.after)).toEqual([]);
      }
    );
  });

  it('control: the same pool on a re-run is not a stale member', () => {
    expect(
      run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-old']).status
    ).toBe(0);
    const again = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-old']);
    expect(again.status, again.stderr).toBe(0);
  });

  it('a disabled service account: stops with the enable command, grants nothing', () => {
    expect(run(['--project', 'sam-vm-test', '--api-url', ISSUER]).status).toBe(0);
    setGcp((db) => {
      db.accounts['sam-nodes@sam-vm-test.iam.gserviceaccount.com'].disabled = true;
    });
    const before = calls().length;
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'service account sam-nodes@sam-vm-test.iam.gserviceaccount.com is disabled'
    );
    expect(result.stderr).toContain('gcloud iam service-accounts enable');
    expect(
      result.calls.slice(before).filter((c) => MUTATING.test(c) && !c.startsWith('services enable'))
    ).toEqual([]);
  });

  it('refuses to retarget a provider that already trusts another install', () => {
    run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-shared']);
    const other = 'https://api.other.example.org';
    const result = run(
      ['--project', 'sam-vm-test', '--api-url', other, '--pool-id', 'sam-shared'],
      other
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`provider sam-api trusts ${ISSUER}, not ${other}`);
    expect(gcp().providers['sam-api'].issuer).toBe(ISSUER);
  });

  it('says a failed first IAM binding on the new service account is being retried', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER], ISSUER, {
      FAKE_GCLOUD_FAIL_ONCE: 'projects add-iam-policy-binding',
      GCP_BOOTSTRAP_RETRY_SECONDS: '0',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Retrying in 0s (attempt 1 of 5)');
    expect(gcp().bindings.length).toBeGreaterThan(0);
  });

  // S1: the node service account binding is pool-wide, so a reused pool must hold nothing but
  // this install's provider.
  describe('an existing --pool-id', () => {
    const seedPool = (providers: Record<string, { issuer: string; state?: string }>) => {
      writeFileSync(
        join(state, 'gcp.json'),
        JSON.stringify({
          pools: { 'sam-shared': { description: 'made elsewhere' } },
          providers: Object.fromEntries(
            Object.entries(providers).map(([id, p]) => [id, { ...p, pool: 'sam-shared' }])
          ),
          accounts: {},
          bindings: [],
        })
      );
    };
    const args = ['--project', 'sam-vm-test', '--api-url', ISSUER, '--pool-id', 'sam-shared'];
    const changes = (result: ReturnType<typeof run>) =>
      result.calls.filter((c) => MUTATING.test(c) && !c.startsWith('services'));

    it('is refused when another provider in it trusts another issuer; nothing is bound', () => {
      seedPool({ 'github-actions': { issuer: 'https://token.actions.githubusercontent.com' } });
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'pool sam-shared holds provider github-actions (issuer https://token.actions.githubusercontent.com) besides sam-api'
      );
      expect(changes(result)).toEqual([]);
      expect(gcp().bindings).toEqual([]);
    });

    it('is refused when it also holds this issuer under another provider id', () => {
      seedPool({ 'sam-api': { issuer: ISSUER }, 'sam-api-2': { issuer: ISSUER } });
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `holds provider sam-api-2 (issuer ${ISSUER}) besides sam-api`
      );
      expect(changes(result)).toEqual([]);
    });

    it('is refused when the other provider is soft-deleted (it can be undeleted)', () => {
      seedPool({ other: { issuer: 'https://idp.example.com', state: 'DELETED' } });
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'holds provider other (issuer https://idp.example.com) besides sam-api'
      );
      expect(changes(result)).toEqual([]);
    });

    it('control: reused when it holds only this install provider, or nothing yet', () => {
      seedPool({ 'sam-api': { issuer: ISSUER } });
      const reused = run(args);
      expect(reused.status, reused.stderr).toBe(0);
      expect(reused.stdout).toContain('pool sam-shared: exists');
      expect(reused.calls.filter((c) => / create/.test(c) && c.includes('pools'))).toEqual([]);

      seedPool({});
      const empty = run(args);
      expect(empty.status, empty.stderr).toBe(0);
      expect(gcp().providers['sam-api']).toMatchObject({ issuer: ISSUER, pool: 'sam-shared' });
    });
  });

  it.each(['--project', '--api-url', '--pool-id', '--provider-id', '--service-account'])(
    'a trailing %s with no value is a clear error, not a shift failure',
    (flag) => {
      const result = run(['--project', 'sam-vm-test', flag]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`gcp-bootstrap: ${flag} needs a value`);
      expect(result.calls).toEqual([]);
    }
  );

  it('says to use a project dedicated to SAM nodes', () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER, '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('use a project dedicated to SAM nodes');
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

/**
 * A4: what the bootstrap enables and grants, against what the in-app guided setup does for a user
 * project. Every API or role it leaves out must be on these lists with a reason, and named in
 * the script's own comment, so a new required API fails here until someone decides.
 */
const OMITTED_APIS: Record<string, string> = {
  'cloudresourcemanager.googleapis.com':
    'only the guided setup calls it, with the user OAuth token; nodes never do',
  'aiplatform.googleapis.com': 'Vertex AI for agents in a user project, not node provisioning',
};
/**
 * SA_PROJECT_ROLES in apps/api/src/services/gcp-setup.ts (not exported, so copied here; the test
 * below reads that file and fails when the two differ).
 */
const GUIDED_SETUP_SA_ROLES = [
  'roles/compute.instanceAdmin.v1',
  'roles/compute.securityAdmin',
  'roles/aiplatform.user',
];
const OMITTED_ROLES: Record<string, string> = {
  'roles/aiplatform.user': 'Vertex AI for agents; the node service account only manages VMs',
};

describe('gcp-bootstrap.sh against the guided setup (drift)', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const enabled = () => {
    const result = run(['--project', 'sam-vm-test', '--api-url', ISSUER]);
    expect(result.status, result.stderr).toBe(0);
    const services = result.calls.find((c) => c.startsWith('services enable'))!;
    const roles = result.calls
      .filter((c) => c.startsWith('projects add-iam-policy-binding'))
      .map((c) => /--role=(\S+)/.exec(c)?.[1] ?? '');
    return { apis: services.split(' ').filter((w) => w.endsWith('.googleapis.com')), roles };
  };

  it('enables only APIs the guided setup requires, and omits only listed ones', () => {
    const required = GCP_REQUIRED_APIS.map((api) => api.service);
    const { apis } = enabled();
    expect(apis.length).toBeGreaterThan(0);
    for (const api of apis) expect(required, api).toContain(api);
    expect(required.filter((api) => !apis.includes(api)).sort()).toEqual(
      Object.keys(OMITTED_APIS).sort()
    );
    for (const api of Object.keys(OMITTED_APIS)) expect(script, api).toContain(`#   ${api}:`);
  });

  it('the copied guided-setup role list still matches gcp-setup.ts', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../apps/api/src/services/gcp-setup.ts'),
      'utf8'
    );
    const list = /const SA_PROJECT_ROLES = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect([...list.matchAll(/'(roles\/[^']+)'/g)].map((m) => m[1])).toEqual(GUIDED_SETUP_SA_ROLES);
  });

  it('grants only roles the guided setup grants, and omits only listed ones', () => {
    const { roles } = enabled();
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) expect(GUIDED_SETUP_SA_ROLES, role).toContain(role);
    expect(GUIDED_SETUP_SA_ROLES.filter((role) => !roles.includes(role)).sort()).toEqual(
      Object.keys(OMITTED_ROLES).sort()
    );
    for (const role of Object.keys(OMITTED_ROLES)) expect(script, role).toContain(role);
  });
});
