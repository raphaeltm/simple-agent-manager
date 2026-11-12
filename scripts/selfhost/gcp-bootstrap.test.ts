/**
 * deploy/selfhost/gcp-bootstrap.sh against a fake `gcloud` and `curl` on PATH. The fake keeps
 * Google Cloud state as files, so a second run sees what the first created.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../../deploy/selfhost/gcp-bootstrap.sh');
const ISSUER = 'https://api.vmtest.example.org';

// State: one file per resource in $STATE. Every call is appended to $STATE/calls.
const FAKE_GCLOUD = `#!/usr/bin/env bash
echo "$*" >> "$STATE/calls"
args="$*"
case "$args" in
  "projects describe"*) echo 123456789012 ;;
  "services enable"*) ;;
  "iam workload-identity-pools providers describe"*)
    [ -f "$STATE/provider" ] || exit 1
    case "$args" in *"value(oidc.issuerUri)"*) cat "$STATE/provider" ;; esac ;;
  "iam workload-identity-pools providers create-oidc"*)
    for a in "$@"; do case "$a" in --issuer-uri=*) printf '%s' "\${a#--issuer-uri=}" > "$STATE/provider" ;; esac; done ;;
  "iam workload-identity-pools describe"*) [ -f "$STATE/pool" ] || exit 1 ;;
  "iam workload-identity-pools create"*) touch "$STATE/pool" ;;
  "iam service-accounts describe"*) [ -f "$STATE/sa" ] || exit 1 ;;
  "iam service-accounts create"*) touch "$STATE/sa" ;;
  "projects add-iam-policy-binding"*|"iam service-accounts add-iam-policy-binding"*) ;;
  *) echo "fake gcloud: unexpected: $args" >&2; exit 2 ;;
esac
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

function run(args: string[], advertisedIssuer = ISSUER) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      FAKE_ISSUER: advertisedIssuer,
    },
  });
  return { ...result, calls: calls() };
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
    expect(readFileSync(join(state, 'provider'), 'utf8')).toBe(ISSUER);
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
