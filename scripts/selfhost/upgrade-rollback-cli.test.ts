/** Execute the printed command through the real CLI and authenticated in-place recovery. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { encryptBackupTree } from './backup-encryption';
import { expectedComposeProjectFor, recordInstall } from './install-record';
import { rollbackSteps } from './upgrade-instructions';

const FROM = 'a'.repeat(40);
let root: string;
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/rollback-cli-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('executes the emitted populated-target rollback with real decryption, state restore and old checkout', () => {
  const stateDir = join(root, 'custom state');
  const envFile = join(root, 'box.env');
  const key = join(root, 'backup-key');
  const snapshot = join(root, 'snapshot');
  const plain = join(root, 'plain');
  const bucket = join(root, 'bucket');
  mkdirSync(stateDir);
  mkdirSync(bucket);
  const box = { CELLD_BUCKET: 'gs://test/owned', SAM_DOMAIN: 'rollback.test' };
  writeFileSync(envFile, 'CELLD_BUCKET=gs://test/owned\nSAM_DOMAIN=rollback.test\n', {
    mode: 0o600,
  });
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  const id = 'b'.repeat(32);
  writeFileSync(join(stateDir, 'platform-keys.json'), JSON.stringify({ SAM_INSTALLATION_ID: id }));
  writeFileSync(join(stateDir, 'data'), 'old-state');
  recordInstall(stateDir, envFile, box, id);
  mkdirSync(plain);
  cpSync(stateDir, join(plain, 'state'), { recursive: true });
  cpSync(envFile, join(plain, 'env'));
  mkdirSync(join(plain, 'bucket'));
  writeFileSync(join(plain, 'bucket/data'), 'old-rows');
  writeFileSync(
    join(plain, 'backup-manifest.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      bucket: box.CELLD_BUCKET,
      samCommit: FROM,
      precopyMs: 0,
      downtimeMs: 0,
      deltaCopyMs: 0,
      objectCount: 1,
    })
  );
  encryptBackupTree(plain, snapshot, key);
  writeFileSync(join(stateDir, 'data'), 'new-state');
  writeFileSync(join(bucket, 'data'), 'new-rows');
  writeFileSync(join(bucket, 'new-only'), 'must disappear');
  const project = expectedComposeProjectFor(box, stateDir);
  const preload = join(root, 'boundary.cjs');
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (!['git', 'pnpm', 'docker', 'gcloud'].includes(command)) return original(command,args,options);
  fs.appendFileSync(${JSON.stringify(join(root, 'calls'))}, command+' '+args.join(' ')+'\\n');
  let stdout = '';
  if(command === 'git' && args[0] === 'rev-parse') stdout = 'b'.repeat(40);
  if (command === 'docker') {
    if(args.includes('ps')) stdout = 'c'.repeat(64);
    if(args[0]==='inspect') stdout = JSON.stringify([{Destination:'/var/lib/celld', Type:'volume', Name:${JSON.stringify(`${project}_celld-data`)}}]);
    if(args[0]==='volume' && args[1]==='ls') stdout = ${JSON.stringify(`${project}_celld-data`)};
    if(args[0]==='volume' && args[1]==='inspect') stdout = JSON.stringify([{Name:${JSON.stringify(`${project}_celld-data`)},CreatedAt:'2026-11-19T00:00:00Z',Labels:{'com.docker.compose.project':${JSON.stringify(project)},'com.docker.compose.volume':'celld-data'}}]);
    if(args.includes('config')) stdout='celld\\ncaddy';
  }
  if(command === 'gcloud') {
    fs.rmSync(${JSON.stringify(bucket)}, {recursive:true,force:true});
    fs.cpSync(args.at(-2), ${JSON.stringify(bucket)}, {recursive:true});
  }
  return {status:0,stdout,stderr:''};
};
syncBuiltinESMExports();
globalThis.fetch = async () => new Response('healthy', {status:200});
`
  );
  const ctx = { box, stateDir, envFile, encryptionKeyFile: key };
  const command = rollbackSteps(ctx, FROM, snapshot, ['caddy'])[0];
  const tsx = resolve('node_modules/.bin/tsx');
  const cli = resolve('scripts/selfhost/upgrade.ts');
  const result = spawnSync(
    'bash',
    ['-c', `pnpm() { shift; '${tsx}' '${cli}' "$@"; }; ${command}`],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
    }
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('manual rollback completed');
  expect(readFileSync(join(stateDir, 'data'), 'utf8')).toBe('old-state');
  expect(readFileSync(join(bucket, 'data'), 'utf8')).toBe('old-rows');
  const calls = readFileSync(join(root, 'calls'), 'utf8');
  expect(calls.indexOf('gcloud storage rsync')).toBeLessThan(
    calls.indexOf(`git checkout --detach ${FROM}`)
  );
  expect(calls).toContain(`--project-name ${project}`);
  expect(calls).toContain(' build caddy');
  expect(calls).toContain('container rm --force ' + 'c'.repeat(64));
}, 60_000);
