/** Execute the printed command through the real CLI and authenticated in-place recovery. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { encryptBackupTree } from './backup-encryption';
import { expectedComposeProjectFor, readInstallRecord, recordInstall } from './install-record';
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
  const scratchLog = join(root, 'scratch-paths.jsonl');
  if (existsSync(scratchLog)) {
    for (const line of readFileSync(scratchLog, 'utf8').trim().split('\n')) {
      const path = JSON.parse(line) as string;
      // Only exact paths returned by this child's real mkdtemp are eligible for cleanup.
      rmSync(path, { recursive: true, force: true });
    }
  }
  rmSync(root, { recursive: true, force: true });
});

it.each([
  { name: 'uninterrupted', boundary: '', foreign: '' },
  { name: 'SIGKILL after live state moves to previous', boundary: 'previous', foreign: '' },
  { name: 'SIGKILL after restored state becomes live', boundary: 'restored', foreign: '' },
  { name: 'SIGKILL after receipt publication', boundary: 'receipt', foreign: '' },
  { name: 'SIGKILL after stage cleanup', boundary: 'cleanup', foreign: '' },
  { name: 'foreign staging inode after SIGKILL', boundary: 'receipt', foreign: 'stage' },
  { name: 'foreign staged inode after SIGKILL', boundary: 'receipt', foreign: 'staged' },
  { name: 'symlink receipt after SIGKILL', boundary: 'receipt', foreign: 'receipt' },
  { name: 'foreign previous inode after SIGKILL', boundary: 'previous', foreign: 'previous' },
  { name: 'foreign live inode after SIGKILL', boundary: 'restored', foreign: 'live' },
])(
  'executes the emitted populated-target rollback: $name',
  ({ boundary, foreign }) => {
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
    writeFileSync(
      join(stateDir, 'platform-keys.json'),
      JSON.stringify({ SAM_INSTALLATION_ID: id })
    );
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
    // These receipts postdate the snapshot and must survive replacement until health succeeds.
    const upgradePending = { from: FROM, to: 'b'.repeat(40), backupDir: snapshot };
    const project = expectedComposeProjectFor(box, stateDir);
    const cachePending = {
      snapshot,
      name: `${project}_celld-data`,
      createdAt: '2026-11-19T00:00:00Z',
      container: 'c'.repeat(64),
      helpers: [],
    };
    writeFileSync(join(stateDir, 'upgrade-pending.json'), JSON.stringify(upgradePending), {
      mode: 0o600,
    });
    writeFileSync(join(stateDir, 'rollback-cache-pending.json'), JSON.stringify(cachePending), {
      mode: 0o600,
    });
    const killed = join(root, 'killed.json');
    const swapReceipt = join(root, '.custom state.rollback-state.json');
    const preload = join(root, 'boundary.cjs');
    writeFileSync(
      preload,
      `
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const original = cp.spawnSync;
const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (prefix, options) => {
  const path = originalMkdtemp(prefix, options);
  if (prefix === ${JSON.stringify(resolve('.tmp/selfhost-backups/operation-'))})
    fs.appendFileSync(${JSON.stringify(join(root, 'scratch-paths.jsonl'))}, JSON.stringify(path)+'\\n');
  return path;
};
const boundary = ${JSON.stringify(boundary)};
const markKilled = (source, destination) => {
  if (fs.existsSync(${JSON.stringify(killed)})) return;
  const swap = JSON.parse(fs.readFileSync(${JSON.stringify(swapReceipt)}, 'utf8'));
  fs.writeFileSync(${JSON.stringify(killed)}, JSON.stringify({source, destination, stage:swap.stage}), {mode:0o600});
  process.kill(process.pid, 'SIGKILL');
};
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
  originalRename(source, destination);
  if (
    (boundary === 'previous' && source === ${JSON.stringify(stateDir)} && require('node:path').basename(destination) === 'previous') ||
    (boundary === 'restored' && destination === ${JSON.stringify(stateDir)} && require('node:path').basename(source) === 'restored') ||
    (boundary === 'receipt' && destination === ${JSON.stringify(swapReceipt)})
  ) markKilled(source, destination);
};
const originalRm = fs.rmSync;
fs.rmSync = (path, options) => {
  originalRm(path, options);
  if (boundary === 'cleanup' && fs.existsSync(${JSON.stringify(swapReceipt)})) {
    const swap = JSON.parse(fs.readFileSync(${JSON.stringify(swapReceipt)}, 'utf8'));
    if (path === swap.stage) markKilled(path, ${JSON.stringify(stateDir)});
  }
};
let container = 'c'.repeat(64);
let volume = true;
let created = '2026-11-19T00:00:00Z';
cp.spawnSync = (command, args, options) => {
  if (!['git', 'pnpm', 'docker', 'gcloud'].includes(command)) return original(command,args,options);
  fs.appendFileSync(${JSON.stringify(join(root, 'calls'))}, command+' '+args.join(' ')+'\\n');
  let stdout = '';
  if(command === 'git' && args[0] === 'rev-parse') stdout = args[1] === '--show-toplevel' ? ${JSON.stringify(root)} : 'b'.repeat(40);
  if (command === 'docker') {
    if(args[0]==='container' && args[1]==='rm') container='';
    if(args[0]==='volume' && args[1]==='rm') volume=false;
    if(args.includes('up')) { container='d'.repeat(64); volume=true; created=new Date().toISOString(); }
    if(args.includes('ps')) stdout = args.includes('label=com.docker.compose.service=celld-data-owner') ? '' : container;
    if(args[0]==='inspect') stdout = args[2]?.includes('{{json .Id}}')
      ? JSON.stringify({Id:container,Created:created,Config:{Labels:{'com.docker.compose.project':${JSON.stringify(project)},'com.docker.compose.service':'celld','com.docker.compose.project.config_files':${JSON.stringify(resolve('deploy/selfhost/docker-compose.yml'))},'com.docker.compose.project.working_dir':${JSON.stringify(resolve('deploy/selfhost'))}}}})
      : JSON.stringify([{Destination:'/var/lib/celld', Type:'volume', Name:${JSON.stringify(`${project}_celld-data`)}}]);
    if(args[0]==='volume' && args[1]==='ls') stdout = volume ? ${JSON.stringify(`${project}_celld-data`)} : '';
    if(args[0]==='volume' && args[1]==='inspect') stdout = JSON.stringify([{Name:${JSON.stringify(`${project}_celld-data`)},CreatedAt:created,Labels:{'com.docker.compose.project':${JSON.stringify(project)},'com.docker.compose.volume':'celld-data'}}]);
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
    const run = () =>
      spawnSync('bash', ['-c', `pnpm() { shift; '${tsx}' '${cli}' "$@"; }; ${command}`], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      });
    let result = run();
    if (boundary) {
      expect(result.status).not.toBe(0);
      expect(existsSync(killed)).toBe(true);
      const interrupted = JSON.parse(readFileSync(killed, 'utf8')) as {
        source: string;
        destination: string;
        stage: string;
      };
      // The marker is written only after the real filesystem operation, never by a fake restore.
      expect(existsSync(interrupted.source)).toBe(false);
      expect(existsSync(interrupted.destination)).toBe(true);
      const restored = ['previous', 'receipt'].includes(boundary)
        ? join(interrupted.stage, 'restored')
        : stateDir;
      expect(existsSync(swapReceipt)).toBe(true);
      expect(existsSync(interrupted.stage)).toBe(boundary !== 'cleanup');
      expect(readFileSync(join(restored, 'data'), 'utf8')).toBe('old-state');
      const stagedState = lstatSync(restored);
      const stagedLedger = readInstallRecord(restored).find(
        (entry) => entry.kind === 'state-dir' && !entry.removedAt
      );
      expect(stagedLedger?.attributes).toMatchObject({
        device: String(stagedState.dev),
        inode: String(stagedState.ino),
      });
      expect(JSON.parse(readFileSync(join(restored, 'upgrade-pending.json'), 'utf8'))).toEqual(
        upgradePending
      );
      expect(
        JSON.parse(readFileSync(join(restored, 'rollback-cache-pending.json'), 'utf8'))
      ).toEqual(cachePending);
      const beforeRetry = readFileSync(join(root, 'calls'), 'utf8');
      expect(beforeRetry).toContain('gcloud storage rsync');
      expect(beforeRetry).not.toContain('container rm');
      expect(beforeRetry).not.toContain('volume rm');
      if (foreign) {
        // Same data/installation but a different inode must never inherit swap authorization.
        const target =
          foreign === 'stage'
            ? interrupted.stage
            : foreign === 'staged'
              ? join(interrupted.stage, 'restored')
              : foreign === 'receipt'
                ? swapReceipt
                : interrupted.destination;
        const retained = join(root, 'retained original');
        const originalInode = lstatSync(target).ino;
        renameSync(target, retained);
        if (foreign === 'receipt') symlinkSync(retained, target);
        else cpSync(retained, target, { recursive: true });
        expect(lstatSync(target).ino).not.toBe(originalInode);
        if (foreign !== 'receipt')
          writeFileSync(join(target, 'foreign-marker'), 'preserve foreign directory');
        result = run();
        expect(result.status).not.toBe(0);
        if (foreign === 'receipt') {
          expect(lstatSync(target).isSymbolicLink()).toBe(true);
          expect(readFileSync(target, 'utf8')).toBe(readFileSync(retained, 'utf8'));
        } else
          expect(readFileSync(join(target, 'foreign-marker'), 'utf8')).toBe(
            'preserve foreign directory'
          );
        expect(existsSync(retained)).toBe(true);
        const retryCalls = readFileSync(join(root, 'calls'), 'utf8').slice(beforeRetry.length);
        expect(retryCalls).not.toContain('gcloud storage rsync');
        expect(retryCalls).not.toContain('container rm');
        expect(retryCalls).not.toContain('volume rm');
        return;
      }
      // Reuse precisely the operator's emitted command, including its state path with spaces.
      result = run();
    }
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('manual rollback completed');
    expect(readFileSync(join(stateDir, 'data'), 'utf8')).toBe('old-state');
    expect(readFileSync(join(bucket, 'data'), 'utf8')).toBe('old-rows');
    expect(existsSync(join(bucket, 'new-only'))).toBe(false);
    const state = lstatSync(stateDir);
    const receipt = readInstallRecord(stateDir).filter(
      (entry) => entry.kind === 'state-dir' && !entry.removedAt
    );
    expect(receipt).toHaveLength(1);
    expect(receipt[0]?.attributes).toMatchObject({
      device: String(state.dev),
      inode: String(state.ino),
    });
    expect(existsSync(join(stateDir, 'upgrade-pending.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'rollback-cache-pending.json'))).toBe(false);
    expect(existsSync(swapReceipt)).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.startsWith('.rollback-state-'))).toEqual([]);
    const calls = readFileSync(join(root, 'calls'), 'utf8');
    expect(calls.indexOf('gcloud storage rsync')).toBeLessThan(
      calls.indexOf(`git checkout --detach ${FROM}`)
    );
    expect(calls).toContain(`--project-name ${project}`);
    expect(calls).toContain(' build caddy');
    expect(calls).toContain('container rm --force ' + 'c'.repeat(64));
  },
  60_000
);
