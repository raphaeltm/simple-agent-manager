/**
 * The egress fence applied for real: the rendered ruleset installed in a network namespace,
 * probed rule class by rule class as the fenced uid and as a control uid; fence.sh keeping it
 * applied; and celld/start.sh starting only under the full fence and killing celld when it goes.
 *
 * Every forbidden target has a listener (in the peer namespace, or on this namespace's own
 * addresses), so the control uid reaches it and only the fence can explain a refusal.
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildFencePlan, renderFenceRuleset } from '../egress-fence.js';
import {
  buildProbeScript,
  formatProbes,
  parseProbeOutput,
  type ProbeOutcome,
  type ProbeSpec,
  startCheckProbes,
} from '../fence-probes.js';
import { FENCED_PUBLIC_ADDRESS, labUnavailableReason, NetnsLab } from './netns-lab.js';

const REPO = resolve(import.meta.dirname, '../../..');
const FENCED_UID = 7101;
const CONTROL_UID = 65534;
const unavailable = labUnavailableReason();
// CI must run this suite: a runner without the tools is a failure there, not a skip.
if (unavailable && process.env.CI)
  throw new Error(`fence netns lab unavailable in CI: ${unavailable}`);

const plan = buildFencePlan({
  box: { SAM_EGRESS_ALLOW: '192.168.255.1:8000' },
  leaseRange: { start: 20000, end: 20009 },
  resolvConf: 'nameserver 10.99.0.2\n',
  objectStore: [],
  localAddresses: ['127.0.0.1', '::1', FENCED_PUBLIC_ADDRESS, '10.99.0.1', 'fd99::1'],
});
const RULES = renderFenceRuleset(plan);

interface Case extends ProbeSpec {
  name: string;
  fenced: ProbeOutcome;
  control: ProbeOutcome;
}

const blocked = (
  name: string,
  host: string,
  port: number,
  protocol: 'tcp' | 'udp' = 'tcp'
): Case => ({
  name,
  host,
  port,
  protocol,
  fenced: 'blocked',
  control: 'open',
});
const allowed = (name: string, host: string, port: number): Case => ({
  name,
  host,
  port,
  fenced: 'open',
  control: 'open',
});

const CASES: Case[] = [
  blocked('celld operator port, 127.0.0.1', '127.0.0.1', 7001),
  blocked('another loopback address, 127.0.0.2', '127.0.0.2', 7001),
  blocked('IPv6 loopback', '::1', 7001),
  blocked('IPv4-mapped loopback', '::ffff:127.0.0.1', 7001),
  blocked("this host's own public IPv4 address, operator port", FENCED_PUBLIC_ADDRESS, 7001),
  blocked("this host's own private IPv4 address, operator port", '10.99.0.1', 7001),
  blocked("this host's own IPv6 address, operator port", 'fd99::1', 7001),
  blocked('the Caddy port on loopback (not the public path)', '127.0.0.1', 80),
  blocked('private 10/8', '10.255.255.1', 80),
  blocked('cloud metadata 169.254.169.254', '169.254.169.254', 80),
  blocked('Alibaba metadata in CGNAT', '100.100.100.200', 80),
  blocked('private 192.168/16 on a port not allowlisted', '192.168.255.1', 80),
  blocked('private 172.16/12', '172.16.255.1', 80),
  blocked('DNS port on a host that is not a nameserver', '10.255.255.1', 53),
  blocked('IPv6 unique-local', 'fd00::1', 80),
  blocked('GCE metadata over IPv6', 'fd20:ce::254', 80),
  blocked('6to4 (2002::/16)', '2002:a9fe:a9fe::1', 80),
  blocked('Teredo (2001::/32)', '2001::1', 80),
  // Nothing listens on UDP in the peer, so the control's second datagram is refused.
  { ...blocked('UDP to a private address', '10.255.255.1', 161, 'udp'), control: 'refused' },
  { ...blocked('UDP to loopback', '127.0.0.1', 7001, 'udp'), control: 'refused' },
  { ...blocked('UDP to IPv6 loopback', '::1', 7001, 'udp'), control: 'refused' },
  allowed('node lease port on 127.0.0.1', '127.0.0.1', 20000),
  allowed("Caddy on this host's own public address", FENCED_PUBLIC_ADDRESS, 80),
  allowed("Caddy on this host's own private address", '10.99.0.1', 80),
  allowed('SAM_EGRESS_ALLOW entry at its exact address and port', '192.168.255.1', 8000),
  allowed('DNS to the configured nameserver', '10.99.0.2', 53),
  allowed('public IPv4 (stand-in)', '93.184.216.34', 80),
  allowed('public IPv6 (stand-in)', '2606:2800:220:1::1', 80),
];

describe.skipIf(unavailable !== null)('egress fence in a network namespace', () => {
  const lab = new NetnsLab();
  const dir = mkdtempSync(join(tmpdir(), 'fence-netns-'));
  chmodSync(dir, 0o755);
  const rulesFile = join(dir, 'egress-fence.nft');
  writeFileSync(rulesFile, RULES, { mode: 0o644 });

  const probe = (cases: readonly ProbeSpec[], uid: number): Map<number, ProbeOutcome> =>
    parseProbeOutput(
      lab.exec(lab.fenced, ['/bin/bash', '-c', buildProbeScript(cases, 2)], uid).output
    );

  beforeAll(() => {
    lab.setup([80, 8000, 53, 161], [7001, 20000, 80]);
  });
  afterAll(() => lab.teardown());

  describe('the rendered ruleset, rule class by rule class', () => {
    let fenced: Map<number, ProbeOutcome>;
    let control: Map<number, ProbeOutcome>;
    let unfenced: Map<number, ProbeOutcome>;

    beforeAll(async () => {
      const listeners = [
        { host: '10.255.255.1', port: 80 },
        { host: '127.0.0.1', port: 20000 },
      ];
      await waitFor(() => [...probe(listeners, CONTROL_UID).values()].every((o) => o === 'open'));
      unfenced = probe(CASES, FENCED_UID);
      lab.nft(lab.fenced, ['-f', rulesFile]);
      fenced = probe(CASES, FENCED_UID);
      control = probe(CASES, CONTROL_UID);
    });

    it.each(CASES.map((c, index) => [c.name, index] as const))('%s', (_name, index) => {
      const testCase = CASES[index]!;
      expect({ fenced: fenced.get(index), control: control.get(index) }).toEqual({
        fenced: testCase.fenced,
        control: testCase.control,
      });
    });

    it('control: without the table the fenced uid reaches every target the control uid does', () => {
      CASES.forEach((testCase, index) =>
        expect([testCase.name, unfenced.get(index)]).toEqual([testCase.name, testCase.control])
      );
    });
  });

  describe('fence.sh and celld/start.sh', () => {
    const attestation = join(dir, 'attestation');
    /** An attestation the test writes itself (fence.sh's file is root-owned). */
    const manual = join(dir, 'manual-attestation');
    const resolvFile = join(dir, 'resolv.conf');
    let fence: ChildProcess;

    const startFence = (): ChildProcess =>
      lab.spawn(
        lab.fenced,
        ['/bin/sh', join(REPO, 'deploy/selfhost/egress-fence/fence.sh'), 'run'],
        {
          SAM_EGRESS_FENCE_RULES: rulesFile,
          SAM_EGRESS_FENCE_STATE: join(dir, 'applied'),
          SAM_EGRESS_FENCE_ATTESTATION: attestation,
          SAM_EGRESS_FENCE_RESOLV_FILES: resolvFile,
          SAM_EGRESS_FENCE_RECHECK_SECONDS: '1',
          PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        }
      );
    const table = (): string =>
      lab.exec(lab.fenced, ['/usr/sbin/nft', 'list', 'table', 'inet', 'sam_celld_egress']).output;

    beforeAll(async () => {
      writeFileSync(resolvFile, 'nameserver 10.99.0.2\n');
      lab.nft(lab.fenced, ['flush', 'ruleset']);
      fence = startFence();
      await waitFor(() => existsSync(attestation));
    });

    it('applies the table and attests to it', () => {
      expect(table()).toContain('meta skuid 7101 jump celld');
      expect(readFileSync(attestation, 'utf8')).toMatch(/^ok \d+\n$/);
    });

    it('re-applies the table after a firewall reload flushes the ruleset', async () => {
      lab.nft(lab.fenced, ['flush', 'ruleset']);
      expect(table()).not.toContain('jump celld');
      await waitFor(() => table().includes('meta skuid 7101 jump celld'), 5000);
      expect(probe([{ host: '10.255.255.1', port: 80 }], FENCED_UID).get(0)).toBe('blocked');
    });

    it('follows a nameserver change, so DNS is not cut off silently', async () => {
      writeFileSync(resolvFile, 'nameserver 192.168.255.1\n');
      await waitFor(() => /chain dns \{\n[^\n]*192\.168\.255\.1[^\n]*dport 53/.test(table()), 5000);
      expect(probe([{ host: '192.168.255.1', port: 53 }], FENCED_UID).get(0)).not.toBe('blocked');
      expect(probe([{ host: '10.99.0.2', port: 53 }], FENCED_UID).get(0)).toBe('blocked');
      writeFileSync(resolvFile, 'nameserver 10.99.0.2\n');
      await waitFor(() => /chain dns \{\n[^\n]*10\.99\.0\.2[^\n]*dport 53/.test(table()), 5000);
    });

    it('celld starts under the full fence, and is killed within the check window when it goes', async () => {
      const run = startCelld();
      await waitFor(() => existsSync(run.pidFile), 10_000);
      const pid = Number(readFileSync(run.pidFile, 'utf8'));
      expect(existsSync(`/proc/${pid}`)).toBe(true);
      fence.kill('SIGKILL');
      lab.killInNamespace(lab.fenced, 'egress-fence/fence.sh');
      const removedAt = Date.now();
      lab.nft(lab.fenced, ['flush', 'ruleset']);
      const status = await run.exited;
      const window = Date.now() - removedAt;
      expect(status).toBe(1);
      expect(run.output()).toMatch(
        /egress fence is gone \(loopback-v4 \(127\.0\.0\.1:7001\): .*\); killed celld/
      );
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      // Check interval 1 s, plus the immediate re-check: measured well under 2 s.
      expect(window).toBeLessThan(2500);
      console.log(`[fence-netns] celld killed ${window} ms after the table was flushed`);
    });

    it('celld is killed when the fence service stops attesting, even with the table intact', async () => {
      lab.nft(lab.fenced, ['-f', rulesFile]);
      writeFileSync(manual, `ok ${Math.floor(Date.now() / 1000)}\n`, { mode: 0o644 });
      const run = startCelld({
        SAM_EGRESS_FENCE_ATTESTATION: manual,
        SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS: '2',
      });
      await waitFor(() => existsSync(run.pidFile), 10_000);
      expect(await run.exited).toBe(1);
      expect(run.output()).toMatch(
        /egress fence is gone \(attestation 'ok \d+' is not a recent ok/
      );
    });

    it.each([
      ['the private-range rule', 'ip daddr {', 'private-v4'],
      ['the IPv6 rule', 'ip6 daddr {', 'unique-local-v6'],
      // Loopback and private local addresses are still refused by the range rules; the public
      // address on the NIC is what only the local-address rule covers.
      ['the local-address rule', 'fib daddr type local counter reject', 'host-address-v4'],
    ])('celld does not start when the table lacks %s', async (_name, prefix, probeName) => {
      const partial = RULES.split('\n')
        .filter((line) => !(line.trim().startsWith(prefix) && line.includes('reject')))
        .join('\n');
      const partialFile = join(dir, `partial-${probeName}.nft`);
      writeFileSync(partialFile, partial, { mode: 0o644 });
      lab.nft(lab.fenced, ['-f', partialFile]);
      writeFileSync(manual, `ok ${Math.floor(Date.now() / 1000) + 3600}\n`, { mode: 0o644 });
      const run = startCelld({
        SAM_EGRESS_FENCE_ATTESTATION: manual,
        SAM_EGRESS_FENCE_WAIT_SECONDS: '2',
      });
      expect(await run.exited).toBe(1);
      expect(run.output()).toMatch(new RegExp(`egress fence is not in effect \\(${probeName} `));
      expect(existsSync(run.pidFile)).toBe(false);
    });

    function startCelld(env: Record<string, string> = {}) {
      // Written by the fake celld, which runs as the fenced uid.
      const pidDir = mkdtempSync(join(dir, 'pid-'));
      chmodSync(pidDir, 0o777);
      const pidFile = join(pidDir, 'celld.pid');
      const fake = join(dir, 'fake-celld.sh');
      // Ignores SIGTERM, as celld does while it drains for up to its shutdown budget.
      writeFileSync(fake, '#!/bin/bash\ntrap "" TERM\necho $$ > "$1"\nexec sleep 300\n', {
        mode: 0o755,
      });
      const start = join(dir, 'start.sh');
      writeFileSync(start, readFileSync(join(REPO, 'deploy/selfhost/celld/start.sh')), {
        mode: 0o755,
      });
      const child = lab.spawn(
        lab.fenced,
        [
          '/usr/bin/setpriv',
          `--reuid=${FENCED_UID}`,
          `--regid=${FENCED_UID}`,
          '--clear-groups',
          '/bin/bash',
          start,
          pidFile,
        ],
        {
          PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
          SAM_CELLD_BIN: fake,
          SAM_EGRESS_FENCE_PROBES: formatProbes(startCheckProbes(plan)),
          SAM_EGRESS_FENCE_ATTESTATION: attestation,
          SAM_EGRESS_FENCE_CHECK_SECONDS: '1',
          SAM_EGRESS_FENCE_WAIT_SECONDS: '10',
          ...env,
        }
      );
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
      return { pidFile, exited, output: () => output };
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((done) => setTimeout(done, 100));
  }
}
