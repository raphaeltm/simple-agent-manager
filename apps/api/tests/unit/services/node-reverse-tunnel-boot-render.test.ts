// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import type * as CloudInit from '@simple-agent-manager/cloud-init';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import { installReverseTunnelTransport } from '../../../src/selfhost/reverse-tunnel/transport';
import { provisionNode } from '../../../src/services/nodes';
import { applySqliteMigration } from '../../helpers/sqlite-d1';
import { env, freshNode, mocks, setEnv, sqlite, tunnelEnv } from './node-tunnel-fixture';

/**
 * L18 vertical slice: the real provisionNode leases a reverse-tunnel port, the self-host driver
 * passes the lease to the REAL cloud-init renderer (the fixture's capture mock is bypassed), and
 * the provider receives user-data that boots frpc against that lease. The lifecycle slice
 * (node-reverse-tunnel-lifecycle.test.ts) covers leases and teardown with captured variables;
 * this one proves the rendered boot document is what a node would actually run.
 */
const GATEWAY_SECRET = ['gateway', 'fixture', 'value', 'for', 'reverse', 'tunnel', 'tests'].join(
  '-'
);

const rendered: string[] = [];

type BootDoc = {
  runcmd: string[];
  write_files: Array<{ path: string; content: string; permissions?: string; owner?: string }>;
};

function file(doc: BootDoc, path: string) {
  const entry = doc.write_files.find((f) => f.path === path);
  if (!entry) throw new Error(`missing write_files entry ${path}`);
  return entry;
}

beforeEach(async () => {
  rendered.length = 0;
  applySqliteMigration(
    sqlite,
    new URL('../../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql', import.meta.url)
  );
  const real = await vi.importActual<typeof CloudInit>('@simple-agent-manager/cloud-init');
  installReverseTunnelTransport((variables) => {
    const userData = real.generateCloudInit(variables);
    rendered.push(userData);
    return userData;
  });
});

describe('reverse-tunnel node boot document', () => {
  it('renders frpc bound to the leased port, with the credential only in the root-only file', async () => {
    setEnv(
      tunnelEnv({
        VM_AGENT_TRANSPORT: 'reverse-tunnel',
        REVERSE_TUNNEL_GATEWAY_SECRET: GATEWAY_SECRET,
        ENCRYPTION_KEY: 'test-encryption-key-for-reverse-tunnel-credentials',
        CF_API_TOKEN: undefined,
        CF_ACCOUNT_ID: undefined,
        CF_ZONE_ID: undefined,
      })
    );
    const node = await freshNode();
    await expect(provisionNode(node.id, env)).resolves.toEqual({
      allocationConfirmed: true,
    });

    expect(rendered).toHaveLength(1);
    const userData = rendered[0]!;
    // The provider received exactly the document the real renderer produced.
    expect(mocks.createVM).toHaveBeenCalledWith(expect.objectContaining({ userData }));

    const lease = sqlite
      .prepare('SELECT port FROM node_reverse_tunnel_leases WHERE node_id = ?')
      .get(node.id) as { port: number };
    // The fixture's capture mock was bypassed: the real renderer produced this document.
    expect(mocks.cloudInitVars).toHaveLength(0);

    const doc = YAML.parse(userData) as BootDoc;
    const frpc = file(doc, '/etc/sam/frpc/frpc.toml');
    expect(frpc.content).toMatch(new RegExp(`^remotePort = ${lease.port}$`, 'm'));
    expect(frpc.content).toMatch(/^localPort = 8444$/m);
    expect(frpc.content).toContain(`user = "${node.id}"`);
    expect(frpc.content).toContain(
      'metadatas.credential = "{{ .Envs.SAM_REVERSE_TUNNEL_CREDENTIAL }}"'
    );

    const credentialFile = file(doc, '/etc/sam/frpc/credential.env');
    expect(credentialFile.permissions).toBe('0400');
    const [, secret] = /^SAM_REVERSE_TUNNEL_CREDENTIAL=([A-Za-z0-9_-]{43})$/m.exec(
      credentialFile.content
    )!;
    // The credential appears in exactly one place in the whole boot document.
    expect(userData.split(secret!).length - 1).toBe(1);

    file(doc, '/etc/systemd/system/sam-frpc.service');
    expect(doc.runcmd.join('\n')).toContain('systemctl enable --now sam-frpc.service');
    // No Cloudflare ingress, no Origin CA, no public agent ingress.
    expect(userData).not.toMatch(
      /sam-cloudflared|cloudflared-linux|origin-ca-certificate|PHASE START: origin-ca/
    );
  });

  it('control: a Cloudflare node never reaches the reverse-tunnel renderer', async () => {
    setEnv(tunnelEnv({ VM_AGENT_TRANSPORT: 'cloudflare-tunnel' }));
    const node = await freshNode();
    await provisionNode(node.id, env);

    expect(rendered).toHaveLength(0);
    expect(mocks.cloudInitVars).toHaveLength(1);
    expect(mocks.cloudInitVars[0]).not.toHaveProperty('reverseTunnelCredential');
    // Liveness: this really is the Cloudflare Tunnel provisioning path.
    expect(mocks.cloudInitVars[0]).toMatchObject({ cloudflareTunnelToken: expect.any(String) });
  });
});
