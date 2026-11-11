import { describe, expect, it } from 'vitest';

import { buildProbeScript, parseProbeOutput, type ProbeOutcome } from './fence-probes.js';
import {
  attestationProblem,
  judgeTargets,
  missingNameservers,
  probeSpecs,
  type VerifyTarget,
  verifyTargets,
} from './fence-verify.js';

const RANGE = { start: 20000, end: 29999 };
const LOCAL: VerifyTarget = {
  label: 'celld operator listener',
  host: '127.0.0.1',
  port: 7001,
  expect: 'blocked',
};
const REMOTE: VerifyTarget = {
  label: 'private-v4',
  host: '10.255.255.1',
  port: 80,
  expect: 'blocked',
};
const V6: VerifyTarget = { label: 'unique-local-v6', host: 'fd00::1', port: 80, expect: 'blocked' };
const LEASE: VerifyTarget = {
  label: 'node tunnel lease port',
  host: '127.0.0.1',
  port: 20000,
  expect: 'reachable',
};

/** Results in probeSpecs() order: [tcp, udp] per forbidden target, [tcp] per allowed one. */
const results = (...outcomes: ProbeOutcome[]): Map<number, ProbeOutcome> =>
  new Map(outcomes.map((outcome, index) => [index, outcome]));

describe('verify-fence judging', () => {
  it('probes every forbidden target over TCP and UDP, an allowed one over TCP', () => {
    expect(probeSpecs([LOCAL, LEASE])).toEqual([
      { host: '127.0.0.1', port: 7001, protocol: 'tcp' },
      { host: '127.0.0.1', port: 7001, protocol: 'udp' },
      { host: '127.0.0.1', port: 20000, protocol: 'tcp' },
    ]);
  });

  it('passes when forbidden targets are refused for celld (TCP and UDP) and reachable for another uid', () => {
    const verdict = judgeTargets(
      [LOCAL, REMOTE, LEASE],
      results('blocked', 'blocked', 'blocked', 'blocked', 'open'),
      results('open', 'refused', 'timeout', 'open', 'open')
    );
    expect(verdict).toEqual({ failures: [], notes: [] });
  });

  it('a remote target the network refuses for every uid is judged by UDP, not waved through', () => {
    // TCP looks the same for both uids; the UDP EPERM proves the fence matched (or did not).
    const fenced = judgeTargets(
      [REMOTE],
      results('blocked', 'blocked'),
      results('blocked', 'open')
    );
    expect(fenced.failures).toEqual([]);
    const unfenced = judgeTargets([REMOTE], results('blocked', 'open'), results('blocked', 'open'));
    expect(unfenced.failures).toEqual(['private-v4 (10.255.255.1:80) is NOT fenced: UDP open']);
  });

  it('fails a forbidden target that TCP reaches even when UDP is refused', () => {
    const verdict = judgeTargets([LOCAL], results('open', 'blocked'), results('open', 'refused'));
    expect(verdict.failures).toEqual([
      'celld operator listener (127.0.0.1:7001) is NOT fenced: TCP open',
    ]);
  });

  it('a local target refused for every uid fails: the probe cannot see the fence', () => {
    const verdict = judgeTargets(
      [LOCAL],
      results('blocked', 'blocked'),
      results('blocked', 'blocked')
    );
    expect(verdict.failures[0]).toMatch(/refused for every uid/);
  });

  it("this host's own address counts as local", () => {
    const own: VerifyTarget = { ...LOCAL, host: '10.0.0.4' };
    const verdict = judgeTargets(
      [own],
      results('blocked', 'blocked'),
      results('blocked', 'blocked'),
      new Set(['10.0.0.4'])
    );
    expect(verdict.failures[0]).toMatch(/refused for every uid/);
  });

  it('IPv6 with no route on this host is not applicable; IPv6 that routes must be fenced', () => {
    const off = judgeTargets(
      [V6],
      results('unavailable', 'unavailable'),
      results('unavailable', 'unavailable')
    );
    expect(off).toEqual({
      failures: [],
      notes: ['unique-local-v6: this host has no IPv6 route there; not applicable'],
    });
    const on = judgeTargets([V6], results('timeout', 'open'), results('timeout', 'open'));
    expect(on.failures).toEqual(['unique-local-v6 (fd00::1:80) is NOT fenced: UDP open']);
  });

  it('an allowed target must be reachable, and a missing result fails', () => {
    expect(judgeTargets([LEASE], results('blocked'), results('open')).failures).toEqual([
      'node tunnel lease port (127.0.0.1:20000) should be reachable: blocked',
    ]);
    expect(judgeTargets([LOCAL], new Map(), new Map()).failures).toEqual([
      'celld operator listener (127.0.0.1:7001) is NOT fenced: UDP no result',
    ]);
  });
});

describe('verify-fence targets', () => {
  it('covers every listener, local spelling, remote class and IPv6 form, plus the positive controls', async () => {
    const targets = await verifyTargets({
      box: { S3_ENDPOINT: 'http://127.0.0.1:9000', CELLD_BUCKET: 's3://b' },
      range: RANGE,
      publicProbe: '1.1.1.1:443',
      localAddresses: ['127.0.0.1', '::1', '10.0.0.4', 'fe80::1', '2a01:4f8::1'],
    });
    const blocked = targets.filter((t) => t.expect === 'blocked').map((t) => `${t.host}:${t.port}`);
    const allowed = targets
      .filter((t) => t.expect === 'reachable')
      .map((t) => `${t.host}:${t.port}`);
    expect(blocked).toEqual(
      expect.arrayContaining([
        '127.0.0.1:7001',
        '127.0.0.1:8080',
        '127.0.0.1:7000',
        '127.0.0.1:9001',
        '127.0.0.1:2019',
        '127.0.0.1:443',
        '127.0.0.2:7001',
        '::1:7001',
        '::ffff:127.0.0.1:7001',
        '10.0.0.4:7001',
        '10.0.0.4:2019',
        '2a01:4f8::1:7001',
        '10.255.255.1:80',
        '169.254.169.254:80',
        '100.100.100.200:80',
        '172.17.0.1:80',
        '192.168.255.1:80',
        'fd00::1:80',
        'fd20:ce::254:80',
        '2002:a9fe:a9fe::1:80',
        '2001::1:80',
        '::ffff:169.254.169.254:80',
        '64:ff9b::a9fe:a9fe:80',
      ])
    );
    expect(allowed).toEqual([
      '127.0.0.1:20000',
      '1.1.1.1:443',
      '10.0.0.4:443',
      '2a01:4f8::1:443',
      '127.0.0.1:9000',
    ]);
  });

  it('adds the metadata token proxy for a gs:// bucket', async () => {
    const targets = await verifyTargets({
      box: { CELLD_BUCKET: 'gs://b' },
      range: RANGE,
      publicProbe: '1.1.1.1:443',
      localAddresses: [],
    });
    expect(targets).toContainEqual({
      label: 'metadata token proxy',
      host: '127.0.0.1',
      port: 7180,
      expect: 'reachable',
    });
  });
});

describe('resolver drift and attestation', () => {
  it('reports nameservers celld uses that the DNS sets do not open', () => {
    expect(missingNameservers(['127.0.0.53'], ['127.0.0.53', '1.1.1.1'])).toEqual([]);
    expect(missingNameservers(['10.0.0.2', '127.0.0.53'], ['127.0.0.53'])).toEqual(['10.0.0.2']);
  });

  it('requires a recent ok attestation', () => {
    expect(attestationProblem('ok 1000\n', 1010, 20)).toBeNull();
    expect(attestationProblem('ok 1000\n', 1030, 20)).toMatch(/30s old/);
    expect(attestationProblem("cat: can't open", 1000, 20)).toMatch(/has not attested/);
  });
});

describe('probe script', () => {
  it('runs one probe line per spec in parallel and parses only well-formed results', () => {
    const script = buildProbeScript(
      [
        { host: '::1', port: 7001 },
        { host: '10.0.0.1', port: 9, protocol: 'udp' },
      ],
      4
    );
    expect(script).toContain("probe 0 tcp '::1' 7001 &");
    expect(script).toContain("probe 1 udp '10.0.0.1' 9 &");
    expect(script.trim().endsWith('wait')).toBe(true);
    expect(parseProbeOutput('1 blocked\n0 open\njunk\n7 maybe\n')).toEqual(
      new Map([
        [1, 'blocked'],
        [0, 'open'],
      ])
    );
  });
});

describe('applied DNS sets', () => {
  it('reads the dns4/dns6 elements from nft -j output and ignores everything else', async () => {
    const { dnsSetElements } = await import('./verify-fence.js');
    expect(
      dnsSetElements({
        nftables: [
          { metainfo: {} },
          { set: { name: 'dns4', elem: ['127.0.0.53', '169.254.169.254'] } },
          { set: { name: 'dns6' } },
          { set: { name: 'other', elem: ['10.0.0.1'] } },
          { rule: {} },
        ],
      })
    ).toEqual(['127.0.0.53', '169.254.169.254']);
    expect(dnsSetElements('garbage')).toEqual([]);
  });
});
