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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addResource } from '../../deploy/selfhost/created-resources.mjs';
import { CHILD_TEST_TIMEOUT_MS, runTsx } from './deploy-harness';
import {
  composeProjectFor,
  expectedComposeProjectFor,
  recordInstall,
  recordPath,
} from './install-record';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const CLI = resolve(import.meta.dirname, 'teardown.ts');
const OWN = 'a'.repeat(32);
const DOMAIN = 'sam.example.com';
let dir: string, state: string, env: string, bin: string;
beforeEach(() => {
  for (const name of Object.keys(process.env))
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
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
    `
    const args=process.argv.slice(2),cmd=args.join(' '),project=process.env.PROJECT;
    fs.appendFileSync(process.env.CALLS,'docker '+cmd+'\\n');
    const removed=process.env.CALLS+'.removed',gone=process.env.CALLS+'.volume-removed',live=process.env.LIVE_DOCKER==='yes' || !!process.env.DOCKER_CASE;
    if(cmd.startsWith('container ls')) {
      if(live && !fs.existsSync(removed)) console.log('f'.repeat(64));
    } else if(cmd.startsWith('container inspect')) {
      if(process.env.DOCKER_CASE==='malformed') console.log('{}');
      else console.log(JSON.stringify({id:'f'.repeat(64),labels:{'com.docker.compose.project':process.env.DOCKER_CASE==='foreign'?'foreign':project,'com.docker.compose.service':'celld','com.docker.compose.project.config_files':process.env.CONFIG_FILES,'com.docker.compose.project.working_dir':process.env.CONFIG_DIR}}));
    } else if(cmd.startsWith('volume ls')) {
      if(live && !fs.existsSync(gone)) console.log(project+(process.env.DOCKER_CASE==='missing-volume-label'?'_undefined':'_celld-data'));
    } else if(cmd.startsWith('volume inspect')) {
      const counter=process.env.CALLS+'.volume-checks';
      const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
      fs.writeFileSync(counter,String(count+1));
      console.log(JSON.stringify({name:project+(process.env.DOCKER_CASE==='missing-volume-label'?'_undefined':'_celld-data'),createdAt:process.env.DOCKER_CASE==='replaced' && count>0?'2026-11-02T00:00:00Z':'2026-11-01T00:00:00Z',labels:{'com.docker.compose.project':project,...(process.env.DOCKER_CASE==='missing-volume-label'?{}:{'com.docker.compose.volume':'celld-data'})}}));
    } else if(cmd.startsWith('container rm')) fs.writeFileSync(removed,'yes');
    else if(cmd.startsWith('volume rm')) fs.writeFileSync(gone,'yes');
    else if(!cmd.startsWith('container stop')) {console.error('unexpected Docker command');process.exit(1);}
  `
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
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function executable(name: string, script: string) {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nimport * as fs from 'node:fs';\n${script}\n`);
  chmodSync(file, 0o755);
}
function run(args: string[], extra: Record<string, string> = {}) {
  return runTsx(CLI, ['--box-env', env, '--state-dir', state, ...args], {
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: join(dir, 'calls'),
    PROJECT: composeProjectFor({ SAM_DOMAIN: DOMAIN }, state),
    CONFIG_FILES: resolve(import.meta.dirname, '../../deploy/selfhost/docker-compose.yml'),
    CONFIG_DIR: resolve(import.meta.dirname, '../../deploy/selfhost'),
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
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter(
            (name) => name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_')
          )
          .map((name) => [name, undefined])
      ),
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
    const result = await run(['--keep-data', '--confirm', DOMAIN], { LIVE_DOCKER: 'yes' });
    expect(result.status, result.out).toBe(0);
    expect(calls()).not.toContain('gcloud iam');
    expect(calls()).not.toContain('remove-iam-policy-binding');
    expect(existsSync(env)).toBe(true);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
    expect(calls()).toContain(composeProjectFor({ SAM_DOMAIN: DOMAIN }, state));
    expect(calls()).toContain('container stop');
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

it.each(['foreign', 'malformed', 'replaced', 'missing-volume-label'])(
  'refuses %s live Docker ownership without touching state',
  async (defect) => {
    const result = await run(['--remove-everything', '--destroy-key', '--confirm', DOMAIN], {
      DOCKER_CASE: defect,
    });
    expect(result.status, result.out).toBe(1);
    expect(calls()).not.toContain('container rm');
    expect(calls()).not.toContain('volume rm');
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
    expect(existsSync(env)).toBe(true);
  }
);
it('a reinstall at the same domain and state path gets a different Compose namespace', () => {
  const first = composeProjectFor({ SAM_DOMAIN: DOMAIN }, state);
  writeFileSync(
    join(state, 'platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: 'b'.repeat(32) })
  );
  expect(composeProjectFor({ SAM_DOMAIN: DOMAIN }, state)).not.toBe(first);
});

it.each(['CI', 'GITHUB_ACTIONS', 'RUNNER_NAME'])(
  'refuses %s presence before reading environment or Docker metadata',
  async (marker) => {
    writeFileSync(env, 'INVALID PRIVATE CONFIG', { mode: 0o600 });
    const result = await run([], { [marker]: '' });
    expect(result.status).toBe(1);
    expect(result.out).toContain('forbidden in CI');
    expect(result.out).not.toContain('expected NAME=value');
    expect(calls()).toBe('');
  }
);

it('removes only exact live owned container and volume identities, without a Compose sweep', async () => {
  const result = await run(['--remove-everything', '--confirm', DOMAIN], { LIVE_DOCKER: 'yes' });
  expect(result.status, result.out).toBe(0);
  expect(calls()).toContain(`container rm --force ${'f'.repeat(64)}`);
  expect(calls()).toContain(
    `volume rm ${composeProjectFor({ SAM_DOMAIN: DOMAIN }, state)}_celld-data`
  );
  expect(calls()).not.toContain(' down ');
  expect(existsSync(env)).toBe(false);
});

it('computes the final restore project from an authenticated id before copying keys', () => {
  const final = expectedComposeProjectFor({ SAM_DOMAIN: DOMAIN }, state, OWN);
  rmSync(join(state, 'platform-keys.json'));
  expect(expectedComposeProjectFor({ SAM_DOMAIN: DOMAIN }, state, OWN)).toBe(final);
  expect(() => expectedComposeProjectFor({ SAM_DOMAIN: DOMAIN }, state, 'invalid')).toThrow(
    'Invalid persisted'
  );
  writeFileSync(
    join(state, 'platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: 'invalid' })
  );
  expect(() => expectedComposeProjectFor({ SAM_DOMAIN: DOMAIN }, state)).toThrow('Cannot resolve');
});

it('retains the scoped installation project after teardown removed platform keys', () => {
  const previous = expectedComposeProjectFor({ SAM_DOMAIN: DOMAIN }, state);
  rmSync(join(state, 'platform-keys.json'));
  expect(expectedComposeProjectFor({ SAM_DOMAIN: DOMAIN }, state)).toBe(previous);
});

it('retries --destroy-key safely after a real CLI state-cache removal failure', async () => {
  const cache = join(state, 'go-cache');
  mkdirSync(cache);
  writeFileSync(join(cache, 'fixture'), 'cache');
  const hook = join(dir, 'fail-cache.mjs');
  writeFileSync(
    hook,
    `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.rmSync;fs.rmSync=function(path,...rest){if(process.env.FAIL_CACHE==='yes' && String(path)===process.env.PROTECTED_CACHE){const err=new Error('fixture removal denied');err.code='EPERM';throw err;}return original.call(this,path,...rest);};syncBuiltinESMExports();`
  );
  const first = await run(['--remove-everything', '--destroy-key', '--confirm', DOMAIN], {
    NODE_OPTIONS: `--import=${hook}`,
    FAIL_CACHE: 'yes',
    PROTECTED_CACHE: cache,
  });
  expect(first.status, first.out).toBe(1);
  expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
  expect(existsSync(cache)).toBe(true);
  expect(existsSync(env)).toBe(true);
  const second = await run(['--remove-everything', '--destroy-key', '--confirm', DOMAIN]);
  expect(second.status, second.out).toBe(0);
  expect(existsSync(cache)).toBe(false);
  expect(existsSync(env)).toBe(false);
});
