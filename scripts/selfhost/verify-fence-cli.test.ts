/** Real verification CLI with Docker replaced only at its process boundary. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyTargets } from './fence-verify.js';

const repo = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runCli(mode: string) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/verify-cli-'));
  dirs.push(dir);
  const envFile = join(dir, 'box.env');
  const box = {
    SAM_DOMAIN: 'example.test',
    SAM_TLS_MODE: 'internal',
    CELLD_BUCKET: 's3://fleet',
    GCE_METADATA_PROXY: 'off',
  };
  writeFileSync(
    envFile,
    Object.entries(box)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
    { mode: 0o600 }
  );
  const resolvConf = readFileSync('/etc/resolv.conf', 'utf8');
  const targets = await verifyTargets({
    box,
    range: { start: 20000, end: 29999 },
    publicProbe: '1.1.1.1:443',
    localAddresses: Object.values(networkInterfaces()).flatMap(
      (es) => es?.map((e) => e.address) ?? []
    ),
    resolvConf,
  });
  const outcomes = targets.flatMap((t) =>
    t.expect === 'blocked' ? ['blocked', 'blocked'] : ['open']
  );
  const servers = [...resolvConf.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
  const listing = servers
    .map((host) => `ip daddr ${host} meta l4proto { tcp, udp } th dport 53 accept`)
    .join('\n');
  const calls = join(dir, 'calls.jsonl');
  const script = `#!${process.execPath}
import fs from 'node:fs';const a=process.argv.slice(2),mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
const out=s=>{process.stdout.write(s);process.exit(0)}, fail=()=>process.exit(1);
if(a[0]==='rm')out('');
if(a.includes('run'))out('fake-probe-id');
if(a.includes('ps'))out(mode==='unreadable-fallback'||mode==='stopped-fallback'?'':'running-celld-id');
if(a.includes('getent'))out('1.1.1.1 example.com');
if(a.includes('check')){if(mode==='latched')fail();out('');}
if(a.includes('list')&&a.includes('chain'))out(${JSON.stringify(listing)});
if(a.includes('/run/sam-egress-fence/attestation'))out('ok '+Math.floor(Date.now()/1000)+'\\n');
if(a.includes('/etc/resolv.conf')){if(mode==='unreadable-running'||mode==='unreadable-fallback'||mode==='stopped-fallback'){if(a.includes('compose')||mode!=='stopped-fallback')fail();}out(${JSON.stringify(resolvConf)});}
if(a.includes('bash')){
 const control=a.includes('--user');if(mode==='control-exec'&&control||mode==='workload-exec'&&!control)fail();
 let values=control?${JSON.stringify(outcomes.map(() => 'open'))}:${JSON.stringify(outcomes)};
 if(mode==='control-missing'&&control)values=values.slice(1);
 out(values.map((v,i)=>(mode==='control-missing'&&control?i+1:i)+' '+v).join('\\n')+'\\n');
}
fail();
`;
  writeFileSync(join(dir, 'docker'), script, { mode: 0o755 });
  const result = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('tsx/cli'),
      join(repo, 'scripts/selfhost/verify-fence.ts'),
      '--env-file',
      envFile,
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        COMPOSE_PROFILES: '',
        COMPOSE_FILE: '',
        GCE_METADATA_PROXY: 'off',
      },
      encoding: 'utf8',
    }
  );
  if (!existsSync(calls)) throw new Error(result.stderr);
  return {
    status: result.status,
    text: result.stdout + result.stderr,
    calls: readFileSync(calls, 'utf8'),
  };
}

describe('verify-fence CLI evidence gates', () => {
  it('passes complete live evidence and removes its probe container', async () => {
    const run = await runCli('healthy');
    expect(run.status).toBe(0);
    expect(run.text).toContain('egress fence in effect');
    expect(run.calls).toContain('"rm","-f"');
  });
  it.each([
    'latched',
    'control-exec',
    'workload-exec',
    'control-missing',
    'unreadable-running',
    'unreadable-fallback',
  ])('fails closed on %s despite healthy remaining evidence', async (mode) => {
    const run = await runCli(mode);
    expect(run.status).toBe(1);
    expect(run.text).not.toContain('[selfhost] egress fence in effect');
    expect(run.calls).toContain('"rm","-f"');
  });
  it('uses the probe resolver only after confirming celld is not running', async () => {
    const run = await runCli('stopped-fallback');
    expect(run.status).toBe(0);
    expect(run.calls).toContain('"ps"');
    expect(run.text).toContain('egress fence in effect');
  });
});
