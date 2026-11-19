/** F3: the pinned native celld environment and filesystem are inaccessible to its Worker. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureCelldBinary } from '../celld-binary.js';
import { celldNode, startObjectStore, writeProject } from './celld-lab';
import { LIVE_TMP, skipWithoutDocker } from './harness';

describe.skipIf(skipWithoutDocker)('metadata proxy credential isolation in pinned celld', () => {
  it('native canary is not exposed by process env shim, proc/host files or process execution', async () => {
    mkdirSync(LIVE_TMP, { recursive: true });
    const dir = mkdtempSync(join(LIVE_TMP, 'native-isolation-'));
    const canary = randomBytes(32).toString('hex');
    const nativeFile = join(dir, 'native-canary');
    writeFileSync(nativeFile, canary, { mode: 0o600 });
    const binary = await ensureCelldBinary(join(LIVE_TMP, 'bin'));
    const store = await startObjectStore('isolation-test', randomBytes(24).toString('hex'));
    let running: Awaited<ReturnType<Awaited<ReturnType<typeof celldNode>>['serve']>> | undefined;
    try {
      const node = await celldNode(binary, store, 's3://fleet', { L23_ISOLATION_CANARY: canary });
      const project = writeProject(join(dir, 'project'), {
        name: 'l23-isolation',
        vars: { WORKER_CONTROL: 'visible' },
        worker: `
import process from 'node:process';
import { readFileSync } from 'node:fs';
export default { async fetch(_request, env) {
  const out = { control: env.WORKER_CONTROL === 'visible', nativeCanaryVisible: process.env.L23_ISOLATION_CANARY === ${JSON.stringify(canary)}, denoHidden: true, filesHidden: true, spawnDenied: true, envType: typeof process.env.L23_ISOLATION_CANARY, envOwn: Object.hasOwn(process.env, 'L23_ISOLATION_CANARY'), envNames: Object.keys(process.env) };
  try { out.denoHidden = !globalThis.Deno?.env?.get('L23_ISOLATION_CANARY'); } catch {}
  for (const path of ['/proc/self/environ','/proc/1/environ',${JSON.stringify(nativeFile)},'/etc/sam/celld.env','/run/sam-egress-fence/attestation']) {
    try { const value = readFileSync(path, 'utf8'); if (value.length > 0) out.filesHidden = false; } catch {}
  }
  try { const cp = await import('node:child_process'); cp.execFileSync('/usr/sbin/nft',['flush','ruleset']); out.spawnDenied = false; } catch {}
  return Response.json(out);
}};`,
      });
      running = await node.serve(project);
      expect(readFileSync(`/proc/${running.child.pid}/environ`, 'utf8').includes(canary)).toBe(
        true
      );
      const response = await fetch(`http://127.0.0.1:${node.port}/`);
      expect(await response.json()).toEqual({
        control: true,
        nativeCanaryVisible: false,
        denoHidden: true,
        filesHidden: true,
        spawnDenied: true,
        envType: 'function',
        envOwn: false,
        envNames: [],
      });
    } finally {
      await running?.stop();
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
