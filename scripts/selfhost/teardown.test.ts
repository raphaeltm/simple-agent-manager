/** Real CLI trigger against disposable files and provider executables; no cloud calls. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addResource } from '../../deploy/selfhost/created-resources.mjs';
import { runTsx } from './deploy-harness';
import { composeProjectFor, recordInstall, recordPath } from './install-record';

const CLI = resolve(import.meta.dirname, 'teardown.ts');
const OWN = 'a'.repeat(32);
const DOMAIN = 'sam.example.com';
let dir: string, state: string, env: string, bin: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  dir = mkdtempSync(resolve('.tmp/teardown-'));
  state = join(dir, '.state');
  bin = join(dir, 'bin');
  mkdirSync(state);
  mkdirSync(bin);
  env = join(dir, '.env');
  writeFileSync(env, `SAM_DOMAIN=${DOMAIN}\nGCP_PROJECT=sam-test-proj\n`, { mode: 0o600 });
  writeFileSync(join(state, 'platform-keys.json'), JSON.stringify({ SAM_INSTALLATION_ID: OWN }), {
    mode: 0o600,
  });
  recordInstall(state, env, { SAM_DOMAIN: DOMAIN }, OWN);
  executable(
    'docker',
    `fs.appendFileSync(process.env.CALLS, 'docker '+process.argv.slice(2).join(' ')+'\\n');`
  );
  executable(
    'gcloud',
    `
    const args=process.argv.slice(2), cmd=args.join(' ');
    fs.appendFileSync(process.env.CALLS, 'gcloud '+cmd+'\\n');
    if(cmd.startsWith('compute instances list')) console.log(process.env.VMS ?? '[]');
    else if(cmd.startsWith('compute instances describe')) console.log(process.env.DESCRIBED ?? process.env.VM);
    else if(cmd.startsWith('compute instances delete')) {}
    else if(cmd.startsWith('compute firewall-rules describe')) {
      if(process.env.FIREWALL==='yes' && args[3]==='sam-allow-agent') console.log(JSON.stringify({id: process.env.CHANGED==='yes'?'999':'123',name:args[3],network:'x/networks/default',targetTags:['sam-agent'],description:'SAM installation=${OWN} environment=selfhost issuer=https://api.${DOMAIN}'}));
      else {console.error('NOT_FOUND');process.exit(1);}
    }
    else if(cmd.startsWith('compute firewall-rules delete')) {}
    else if(cmd.startsWith('iam workload-identity-pools providers list')) console.log(process.env.FOREIGN==='pool' ? '[{"name":"foreign","oidc":{"issuerUri":"foreign"}}]' : '[]');
    else if(cmd.startsWith('iam service-accounts get-iam-policy')) console.log(process.env.FOREIGN==='account' ? '{"bindings":[{"role":"foreign","members":["foreign"]}]}' : '{}');
    else if(cmd.startsWith('iam service-accounts keys list')) console.log('[]');
    else if(cmd.startsWith('iam service-accounts describe')) console.log(JSON.stringify({uniqueId:'acct-id',description:'Creates and deletes SAM workspace VMs and their firewall rules for https://api.${DOMAIN}'}));
    else if(cmd.startsWith('iam workload-identity-pools providers describe')) console.log(JSON.stringify({name:'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',oidc:{issuerUri:'https://api.${DOMAIN}'}}));
    else if(cmd.includes('describe')) console.log(JSON.stringify({uniqueId:'acct-id',name:'projects/123/locations/global/workloadIdentityPools/pool',description:'Dedicated to the SAM install whose token issuer is https://api.${DOMAIN}'}));
    else if(cmd.includes('delete')) {}
    else { console.error('unsupported fake command'); process.exit(1); }
  `
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function executable(name: string, script: string) {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nimport * as fs from 'node:fs';\n${script}\n`);
  chmodSync(file, 0o755);
}
function run(args: string[], extra: Record<string, string> = {}) {
  return runTsx(CLI, ['--box-env', env, '--state-dir', state, ...args], {
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: join(dir, 'calls'),
    ...extra,
  });
}
const calls = () =>
  existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
function cloudReceipt(kind: string, name: string, extra: Record<string, string> = {}) {
  addResource(recordPath(state), {
    cloud: 'gcp',
    kind,
    name,
    action: 'created',
    createdBy: 'gcp-bootstrap',
    attributes: {
      project: 'sam-test-proj',
      install: `https://api.${DOMAIN}`,
      environment: 'selfhost',
      installation: OWN,
      identity: '123',
      ...extra,
    },
  });
}
describe('teardown ownership at the CLI boundary', () => {
  it('inventory and dry run do not mutate files or provider resources', async () => {
    expect((await run([])).status).toBe(0);
    expect((await run(['--remove-everything', '--dry-run'])).status).toBe(0);
    expect(existsSync(env)).toBe(true);
    expect(calls()).not.toMatch(/docker compose .* (stop|down)|firewall-rules delete/);
  });
  it('keeps data and all workload identities so the original install can restart', async () => {
    cloudReceipt('workload-identity-pool', 'pool', {
      identity: 'projects/123/locations/global/workloadIdentityPools/pool',
    });
    cloudReceipt('workload-identity-provider', 'provider', { pool: 'pool' });
    cloudReceipt('service-account', 'acct');
    cloudReceipt('iam-binding', 'binding', {
      account: 'acct',
      member: 'serviceAccount:acct',
      role: 'roles/compute.securityAdmin',
    });
    const result = await run(['--keep-data', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(0);
    expect(calls()).not.toContain('gcloud iam');
    expect(calls()).not.toContain('remove-iam-policy-binding');
    expect(existsSync(env)).toBe(true);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
    expect(calls()).toContain(composeProjectFor({ SAM_DOMAIN: DOMAIN }, state));
    expect(calls()).toContain('stop');
  });
  it('deletes owned unused firewall rules with exact id and owner proof', async () => {
    cloudReceipt('firewall-rule', 'sam-allow-agent');
    const result = await run(['--remove-everything', '--confirm', DOMAIN], { FIREWALL: 'yes' });
    expect(result.status, result.out).toBe(0);
    expect(calls()).toContain('firewall-rules delete sam-allow-agent');
    expect(calls()).not.toContain('firewall-rules delete sam-allow-app-routes');
    expect(existsSync(env)).toBe(false);
  });
  it.each(['unrecorded', 'foreign', 'replaced'])('preserves %s firewall rules', async (kind) => {
    if (kind !== 'unrecorded')
      cloudReceipt(
        'firewall-rule',
        'sam-allow-agent',
        kind === 'foreign' ? { installation: 'b'.repeat(32) } : {}
      );
    const result = await run(['--remove-everything', '--confirm', DOMAIN], {
      FIREWALL: 'yes',
      CHANGED: kind === 'replaced' ? 'yes' : 'no',
    });
    expect(result.status, result.out).toBe(1);
    expect(calls()).not.toContain('firewall-rules delete');
  });
  it('refuses the legacy compose project without a creation receipt', async () => {
    rmSync(recordPath(state));
    const result = await run(['--keep-data', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(1);
    expect(calls()).not.toMatch(/docker compose .* (stop|down)/);
  });
  it('cannot adopt cloud resources by name', async () => {
    const result = await run(['--remove-everything', '--adopt-discovered', '--confirm', DOMAIN]);
    expect(result.status).toBe(1);
    expect(calls()).toBe('');
  });
});

it('never adopts an explicit legacy shared compose name during deploy recording', async () => {
  const box = { SAM_DOMAIN: DOMAIN, COMPOSE_PROJECT_NAME: 'sam-selfhost' };
  rmSync(recordPath(state));
  recordInstall(state, env, box, OWN);
  writeFileSync(
    env,
    `SAM_DOMAIN=${DOMAIN}\nCOMPOSE_PROJECT_NAME=sam-selfhost\nGCP_PROJECT=sam-test-proj\n`,
    { mode: 0o600 }
  );
  const result = await run(['--remove-everything', '--confirm', DOMAIN]);
  expect(result.status, result.out).toBe(1);
  expect(calls()).not.toContain(' down ');
  expect(existsSync(env)).toBe(true);
  expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
});
it('different disposable install directories receive different compose identities', () => {
  expect(composeProjectFor({ SAM_DOMAIN: DOMAIN }, state)).not.toBe(
    composeProjectFor({ SAM_DOMAIN: DOMAIN }, join(dir, 'other'))
  );
});

function wifReceipts() {
  cloudReceipt('workload-identity-pool', 'pool', {
    identity: 'projects/123/locations/global/workloadIdentityPools/pool',
    pool: 'pool',
  });
  cloudReceipt('workload-identity-provider', 'provider', {
    identity: 'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
    pool: 'pool',
  });
  cloudReceipt('service-account', 'acct', { identity: 'acct-id', pool: 'pool' });
}
it('removes recorded owned WIF resources and rechecks their current identity', async () => {
  wifReceipts();
  const result = await run(['--remove-everything', '--confirm', DOMAIN]);
  expect(result.status, result.out).toBe(0);
  expect(calls()).toContain('providers delete provider');
  expect(calls()).toContain('workload-identity-pools delete pool');
  expect(calls()).toContain('service-accounts delete acct');
  expect(calls().indexOf('providers delete provider')).toBeLessThan(
    calls().indexOf('workload-identity-pools delete pool')
  );
});
it.each(['pool', 'account'])(
  'preserves a recorded %s when foreign members appeared',
  async (target) => {
    wifReceipts();
    const result = await run(['--remove-everything', '--confirm', DOMAIN], { FOREIGN: target });
    expect(result.status, result.out).toBe(1);
    expect(calls()).not.toContain(
      target === 'pool' ? 'workload-identity-pools delete pool' : 'service-accounts delete acct'
    );
    expect(existsSync(env)).toBe(true);
  }
);

function ownedVm() {
  return {
    id: '123456',
    name: 'sam-node-same-prefix',
    zone: 'projects/sam-test-proj/zones/europe-west1-b',
    labels: {
      managed: 'simple-agent-manager',
      installation: OWN,
      env: 'selfhost',
      node: 'node-id',
    },
    disks: [],
    tags: { items: ['sam-agent'] },
    networkInterfaces: [{ network: 'x/networks/default' }],
  };
}
it('deletes a real-trigger owned node while preserving an identically named foreign installation', async () => {
  const own = ownedVm();
  const foreign = {
    ...ownedVm(),
    id: '654321',
    name: 'sam-node-same-prefix-other',
    labels: { ...own.labels, installation: 'b'.repeat(32) },
  };
  const result = await run(['--keep-data', '--confirm', DOMAIN], {
    VMS: JSON.stringify([own, foreign]),
    VM: JSON.stringify(own),
  });
  expect(result.status, result.out).toBe(1); // foreign explicitly refused and kept
  expect(calls()).toContain('instances delete sam-node-same-prefix ');
  expect(calls()).not.toContain('instances delete sam-node-same-prefix-other');
});
it.each(['changed-id', 'changed-owner', 'duplicate', 'malformed'])(
  'refuses %s VM inventory before destructive deletion',
  async (kind) => {
    const own = ownedVm();
    const described = {
      ...own,
      id: kind === 'changed-id' ? '999' : own.id,
      labels: { ...own.labels, installation: kind === 'changed-owner' ? 'b'.repeat(32) : OWN },
    };
    const result = await run(['--keep-data', '--confirm', DOMAIN], {
      VMS: kind === 'malformed' ? '{}' : JSON.stringify(kind === 'duplicate' ? [own, own] : [own]),
      VM: JSON.stringify(own),
      DESCRIBED: JSON.stringify(described),
    });
    expect(result.status, result.out).toBe(1);
    expect(calls()).not.toContain('instances delete');
  }
);
