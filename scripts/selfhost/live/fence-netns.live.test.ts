/**
 * The egress fence applied for real: the rendered ruleset installed in a network namespace,
 * probed rule class by rule class as the fenced uid and as a control uid; fence.sh keeping it
 * applied; and celld/start.sh starting only under the full fence and killing celld when it goes.
 *
 * Every forbidden target has a listener (in the peer namespace, or on this namespace's own
 * addresses), so the control uid reaches it and only the fence can explain a refusal.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFencePlan,
  FORBIDDEN_IPV4,
  FORBIDDEN_IPV6,
  renderFenceRuleset,
} from '../egress-fence.js';
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
const FENCED_UID = 7103;
const CONTROL_UID = 65534;
const LOG_SECRET = 'bc'.repeat(32);
/** Same as verify-fence: a refused TCP connect is reported ~1 s in (first SYN retransmit). */
const PROBE_TIMEOUT_SECONDS = 4;
const unavailable = labUnavailableReason();
// CI must run this suite: a runner without the tools is a failure there, not a skip.
if (unavailable && process.env.CI)
  throw new Error(`fence netns lab unavailable in CI: ${unavailable}`);

const plan = buildFencePlan({
  box: { SAM_EGRESS_ALLOW: '192.168.255.1:8000,127.0.0.1:20005' },
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
  { ...allowed('UDP DNS to configured resolver', '10.99.0.2', 53), protocol: 'udp' },
  blocked('UDP DNS to non-resolver', '10.255.255.1', 53, 'udp'),
  allowed('public IPv4 (stand-in)', '93.184.216.34', 80),
  allowed('public IPv6 (stand-in)', '2606:2800:220:1::1', 80),
];

describe.skipIf(unavailable !== null)('egress fence in a network namespace', () => {
  const lab = new NetnsLab();
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/fence-netns-'));
  chmodSync(dir, 0o755);
  const rulesFile = join(dir, 'egress-fence.nft');
  writeFileSync(rulesFile, RULES, { mode: 0o644 });

  const probe = (cases: readonly ProbeSpec[], uid: number): Map<number, ProbeOutcome> =>
    parseProbeOutput(
      lab.exec(lab.fenced, ['/bin/bash', '-c', buildProbeScript(cases, PROBE_TIMEOUT_SECONDS)], uid)
        .output
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

    // Every forbidden range, not just the classes above: a mistyped CIDR that nft accepts would
    // otherwise pass. UDP, because only the fence answers a send with EPERM.
    const RANGES = [...FORBIDDEN_IPV4, ...FORBIDDEN_IPV6]
      .map((cidr) => [cidr, representative(cidr)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null);

    it.each(RANGES)('forbidden range %s (UDP to %s)', (_cidr, host) => {
      const spec = [{ host, port: 9, protocol: 'udp' as const }];
      expect(probe(spec, FENCED_UID).get(0)).toBe('blocked');
      expect(probe(spec, CONTROL_UID).get(0)).not.toBe('blocked');
    });

    it('control: without the table the fenced uid reaches every target the control uid does', () => {
      CASES.forEach((testCase, index) =>
        expect([testCase.name, unfenced.get(index)]).toEqual([testCase.name, testCase.control])
      );
    });
  });

  describe('fence loss and operator recovery', () => {
    async function startPair() {
      const state = mkdtempSync(join(dir, 'state-'));
      chmodSync(state, 0o755);
      const attestation = join(state, 'attestation');
      const env = {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        SAM_EGRESS_FENCE_RULES: rulesFile,
        SAM_EGRESS_FENCE_STATE: join(state, 'applied'),
        SAM_EGRESS_FENCE_ATTESTATION: attestation,
        SAM_EGRESS_FENCE_RECHECK_SECONDS: '0.1',
      };
      const fence = lab.spawn(
        lab.fenced,
        ['/bin/sh', join(REPO, 'deploy/selfhost/egress-fence/fence.sh')],
        env
      );
      let fenceOutput = '';
      fence.stderr?.on('data', (b) => {
        fenceOutput += b.toString();
      });
      await waitFor(
        () => existsSync(attestation) && readFileSync(attestation, 'utf8').startsWith('ok ')
      );
      return { state, attestation, env, fence, output: () => fenceOutput };
    }
    function startCelld(attestation: string) {
      const pidDir = mkdtempSync(join(dir, 'pid-'));
      chmodSync(pidDir, 0o777);
      const pidFile = join(pidDir, 'pid');
      const fake = join(pidDir, 'fake-celld.sh');
      writeFileSync(
        fake,
        '#!/bin/bash\necho $$ > "$1"\nprintf \'native stdout %s\\n\' "$GCE_METADATA_PROXY_SECRET"\nprintf \'native stderr %s\\n\' "$GCE_METADATA_PROXY_SECRET" >&2\nexec sleep 300\n',
        { mode: 0o755 }
      );
      const child = lab.spawn(
        lab.fenced,
        [
          '/usr/bin/setpriv',
          `--reuid=${FENCED_UID}`,
          `--regid=${FENCED_UID}`,
          '--clear-groups',
          '/bin/bash',
          join(REPO, 'deploy/selfhost/celld/start.sh'),
          pidFile,
        ],
        {
          PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
          SAM_CELLD_BIN: fake,
          GCE_METADATA_PROXY_SECRET: LOG_SECRET,
          SAM_EGRESS_FENCE_PROBES: formatProbes(startCheckProbes(plan)),
          SAM_EGRESS_FENCE_ATTESTATION: attestation,
          SAM_EGRESS_FENCE_CHECK_SECONDS: '0.1',
          SAM_EGRESS_FENCE_WAIT_SECONDS: '2',
          SAM_EGRESS_FENCE_ATTESTATION_MAX_AGE_SECONDS: '2',
        }
      );
      let output = '';
      child.stderr?.on('data', (b) => {
        output += b.toString();
      });
      child.stdout?.on('data', (b) => {
        output += b.toString();
      });
      const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
      return { child, pidFile, exited, output: () => output };
    }
    function stopFence() {
      lab.killInNamespace(lab.fenced, 'egress-fence/fence.sh');
      lab.killInNamespace(lab.fenced, 'nft monitor');
    }

    it('starts fully fenced, stops within one second after flush, stays stopped, then recovers only on verified operator restart', async () => {
      const pair = await startPair();
      const run = startCelld(pair.attestation);
      await waitFor(() => existsSync(run.pidFile));
      await waitFor(
        () =>
          run.output().includes('native stdout [REDACTED]') &&
          run.output().includes('native stderr [REDACTED]')
      );
      expect(run.output()).not.toContain(LOG_SECRET);
      const pid = Number(readFileSync(run.pidFile, 'utf8'));
      const removedAt = Date.now();
      lab.nft(lab.fenced, ['flush', 'ruleset']);
      expect(await run.exited).toBe(1);
      const elapsed = Date.now() - removedAt;
      expect(elapsed).toBeLessThanOrEqual(1000);
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(run.output()).toContain('egress_fence.celld_killed');
      await waitFor(() => existsSync(join(pair.state, 'lost')));
      expect(pair.output()).toContain('"level":"error","event":"egress_fence.lost"');
      expect(
        lab.exec(
          lab.fenced,
          ['/bin/sh', join(REPO, 'deploy/selfhost/egress-fence/fence.sh'), 'check'],
          undefined
        ).status
      ).not.toBe(0);
      const retry = startCelld(pair.attestation);
      expect(await retry.exited).toBe(1);
      expect(existsSync(retry.pidFile)).toBe(false);
      // No automatic repair: even several check cycles leave the table absent.
      expect(
        lab.exec(lab.fenced, ['/usr/sbin/nft', 'list', 'table', 'inet', 'sam_celld_egress']).status
      ).not.toBe(0);
      stopFence();
      const recovered = await startPair();
      const normal = startCelld(recovered.attestation);
      await waitFor(() => existsSync(normal.pidFile));
      expect(probe([{ host: '10.255.255.1', port: 80, protocol: 'udp' }], FENCED_UID).get(0)).toBe(
        'blocked'
      );
      normal.child.kill('SIGTERM');
      stopFence();
      console.log(`[fence-netns] flush-to-stop ${elapsed}ms`);
    });

    it('keeps serving past the two-second healthy interval, then stops when attestations expire with rules intact', async () => {
      const pair = await startPair();
      const run = startCelld(pair.attestation);
      await waitFor(() => existsSync(run.pidFile));
      const pid = Number(readFileSync(run.pidFile, 'utf8'));
      // Longer than the explicit production max age: healthy re-attestation must keep it alive.
      await new Promise((done) => setTimeout(done, 2200));
      expect(run.child.exitCode).toBeNull();
      expect(existsSync(`/proc/${pid}`)).toBe(true);
      expect(readFileSync(pair.attestation, 'utf8')).toMatch(/^ok \d+\n$/);
      stopFence();
      const stoppedAt = Date.now();
      // Kill the sidecar plus observer, preserving the table and exercising expiry, not a latch.
      expect(existsSync(join(pair.state, 'lost'))).toBe(false);
      expect(probe([{ host: '10.255.255.1', port: 80, protocol: 'udp' }], FENCED_UID).get(0)).toBe(
        'blocked'
      );
      await waitFor(() => run.child.exitCode !== null, 4000);
      expect(await run.exited).toBe(1);
      expect(Date.now() - stoppedAt).toBeLessThanOrEqual(4000);
      expect(run.output()).toContain('egress_fence.celld_killed');
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(existsSync(join(pair.state, 'lost'))).toBe(false);
      expect(probe([{ host: '10.255.255.1', port: 80, protocol: 'udp' }], FENCED_UID).get(0)).toBe(
        'blocked'
      );
    });

    it('latches a transient flush-and-restore from the kernel event stream', async () => {
      const pair = await startPair();
      lab.nft(lab.fenced, ['-f', rulesFile]);
      await waitFor(
        () =>
          existsSync(join(pair.state, 'lost')) &&
          readFileSync(pair.attestation, 'utf8') === 'lost\n'
      );
      expect(readFileSync(pair.attestation, 'utf8')).toBe('lost\n');
      expect(readFileSync(join(pair.state, 'events.jsonl'), 'utf8')).toContain('egress_fence.lost');
      stopFence();
    });

    it('fails closed when the kernel event observer exits', async () => {
      const pair = await startPair();
      lab.killInNamespace(lab.fenced, 'nft monitor');
      await waitFor(
        () =>
          existsSync(join(pair.state, 'lost')) &&
          readFileSync(pair.attestation, 'utf8') === 'lost\n'
      );
      expect(readFileSync(pair.attestation, 'utf8')).toBe('lost\n');
      stopFence();
    });

    it.each([
      ['private-v4', 'ip daddr {'],
      ['unique-local-v6', 'ip6 daddr {'],
      ['host-address-v4', 'fib daddr type local counter reject'],
    ])('does not start when the %s rule class is absent', async (name, prefix) => {
      const state = mkdtempSync(join(dir, 'partial-'));
      chmodSync(state, 0o755);
      const file = join(state, 'attestation');
      writeFileSync(file, `ok ${Math.floor(Date.now() / 1000)}\n`, { mode: 0o644 });
      const partial = RULES.split('\n')
        .filter((line) => !(line.trim().startsWith(prefix) && line.includes('reject')))
        .join('\n');
      const rules = join(state, 'partial.nft');
      writeFileSync(rules, partial);
      lab.nft(lab.fenced, ['-f', rules]);
      const run = startCelld(file);
      expect(await run.exited).toBe(1);
      expect(existsSync(run.pidFile)).toBe(false);
      expect(run.output()).toContain(name);
      lab.nft(lab.fenced, ['-f', rulesFile]);
    });

    it('cannot change the firewall as the workload uid', () => {
      expect(
        lab.exec(lab.fenced, ['/usr/sbin/nft', 'flush', 'ruleset'], FENCED_UID).status
      ).not.toBe(0);
      expect(probe([{ host: '10.255.255.1', port: 80 }], FENCED_UID).get(0)).toBe('blocked');
    });

    it('does not preserve an established forbidden connection after rule recovery', async () => {
      const client = join(dir, 'connection.cjs');
      const result = join(dir, 'connection-result');
      chmodSync(dir, 0o777);
      writeFileSync(
        client,
        `const net=require('node:net'),fs=require('node:fs');
const s=net.connect(8001,'10.99.0.2');s.on('error',()=>{});
s.on('connect',()=>{fs.writeFileSync(process.argv[2],'connected');setTimeout(()=>s.write('after'),1000);});`
      );
      // Dedicated echo socket remains established during restoration.
      const server = lab.spawn(lab.peer, [
        process.execPath,
        '-e',
        "require('node:net').createServer(s=>s.on('data',b=>process.stdout.write(b))).listen(8001,'0.0.0.0')",
      ]);
      let received = '';
      server.stdout?.on('data', (b) => {
        received += b.toString();
      });
      await new Promise((done) => setTimeout(done, 100));
      lab.nft(lab.fenced, ['flush', 'ruleset']);
      const connection = lab.spawn(lab.fenced, [
        '/usr/bin/setpriv',
        `--reuid=${FENCED_UID}`,
        `--regid=${FENCED_UID}`,
        '--clear-groups',
        process.execPath,
        client,
        result,
      ]);
      await waitFor(() => existsSync(result));
      lab.nft(lab.fenced, ['-f', rulesFile]);
      await new Promise((done) => setTimeout(done, 1500));
      expect(received).toBe('');
      connection.kill('SIGKILL');
      server.kill('SIGKILL');
    });
  });
});

/**
 * An address inside `cidr`: the network address plus one. fe80::/10 needs a scope id, which no
 * URL can carry, so it has none; multicast uses a global-scope group.
 */
function representative(cidr: string): string | null {
  const [base = '', bits = '0'] = cidr.split('/');
  if (base === 'fe80::') return null;
  if (base === 'ff00::') return 'ff0e::1';
  if (base === '::') return '::2';
  if (base.includes(':')) return base.endsWith('::') ? `${base}1` : base.replace(/0$/, '1');
  const octets = base.split('.').map(Number);
  const value = octets.reduce((acc, octet) => acc * 256 + octet, 0) + (Number(bits) === 32 ? 0 : 1);
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((done) => setTimeout(done, 100));
  }
}
