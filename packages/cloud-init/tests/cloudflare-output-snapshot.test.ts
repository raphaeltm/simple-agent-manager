/**
 * Byte-identity guard for the Cloudflare deployment's boot output.
 *
 * The self-host reverse-tunnel mode (reverse-tunnel.ts) shares the tunnel firewall, the
 * loopback listener wait gate and the replacement table with the Cloudflare modes. These
 * file snapshots were recorded from `main` (bfa8cc57c) BEFORE that mode was added, so any
 * change to what a direct-ingress (default) or Cloudflare Tunnel node renders fails here.
 * Do not update them to make a reverse-tunnel change pass: a Cloudflare node must render
 * exactly what it rendered before.
 */
import { describe, expect, it } from 'vitest';

import { generateCloudInit } from '../src/generate';
import type { CloudInitVariables } from '../src/variables';

// Synthetic connector token: same base64 JSON shape as a real one, no secret material.
const TUNNEL_TOKEN = Buffer.from(
  JSON.stringify({ a: 'fixture-account', t: 'fixture-tunnel', s: 'fixture-secret' })
).toString('base64');

const base: CloudInitVariables = {
  nodeId: '01SNAPSHOTNODE0000000000000',
  nodeUserId: 'user-snapshot',
  nodeRuntimeIncarnationId: 'incarnation-snapshot',
  hostname: 'node-01snapshotnode0000000000000',
  controlPlaneUrl: 'https://api.example.com',
  jwksUrl: 'https://api.example.com/.well-known/jwks.json',
  callbackToken: 'CALLBACK-SNAPSHOT',
  provider: 'hetzner',
  vmAgentRequiredVersion: '0123456789abcdef0123456789abcdef01234567',
  vmAgentMemoryReserveMb: '1024',
};

const originCa = {
  originCaCertificateUrl:
    'https://api.example.com/api/nodes/01SNAPSHOTNODE0000000000000/origin-ca-certificate',
};

const cases: Array<[string, CloudInitVariables]> = [
  // The default Cloudflare node: direct ingress with a node-local Origin CA certificate.
  ['direct-origin-ca', { ...base, ...originCa }],
  [
    'direct-origin-ca-task',
    {
      ...base,
      ...originCa,
      projectId: 'project-snapshot',
      chatSessionId: 'session-snapshot',
      taskId: 'task-snapshot',
      taskMode: 'conversation',
    },
  ],
  [
    'direct-origin-ca-deployment',
    {
      ...base,
      ...originCa,
      role: 'deployment',
      environmentId: 'env-snapshot',
      deploySigningPubKey: 'PUBKEY-SNAPSHOT',
    },
  ],
  // Minimal legacy direct node (no Origin CA URL).
  ['direct-minimal', { ...base }],
  // Cloudflare Tunnel with every tunnel tunable left at its default.
  ['cloudflare-tunnel-defaults', { ...base, cloudflareTunnelToken: TUNNEL_TOKEN }],
  // Cloudflare Tunnel as provisioning renders it with explicit port and timings.
  [
    'cloudflare-tunnel-configured',
    {
      ...base,
      cloudflareTunnelToken: TUNNEL_TOKEN,
      cloudflareTunnelPort: '8555',
      tunnelListenerWaitSeconds: '200',
      tunnelListenerProbeTimeoutSeconds: '3',
      tunnelListenerProbeIntervalSeconds: '2',
      tunnelConnectorRestartSeconds: '7',
    },
  ],
];

describe('Cloudflare cloud-init output is byte-identical to main', () => {
  it.each(cases)('%s', async (name, variables) => {
    const rendered = generateCloudInit(variables);
    await expect(rendered).toMatchFileSnapshot(`./__snapshots__/cloudflare-output/${name}.yaml`);
  });

  it('no Cloudflare rendering mentions the reverse-tunnel connector', () => {
    for (const [, variables] of cases) {
      const rendered = generateCloudInit(variables);
      expect(rendered).not.toMatch(/frpc|sam-frpc|reverse[_ -]tunnel/i);
    }
  });
});
