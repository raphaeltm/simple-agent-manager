/**
 * The box-side reverse-tunnel config (deploy/selfhost/frps/frps.toml and
 * caddy/sam.d/node-ws.caddy) must agree with the Worker routes and headers it talks to. Each
 * check below is a defect found while running the real box (frps template parsing, celld's
 * X-Forwarded-Host handling, Caddy header_up ordering) or a contract the Worker relies on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS } from '@simple-agent-manager/cloud-init';
import { describe, expect, it } from 'vitest';

import * as box from '../../../../../scripts/selfhost/box-settings';
import {
  GATEWAY_ORIGINAL_HOST_HEADER,
  GATEWAY_SECRET_HEADER,
} from '../../../src/routes/self-host-gateway';
import { FRPS_PLUGIN_OPS } from '../../../src/services/node-reverse-tunnel-authz';
import * as config from '../../../src/services/node-reverse-tunnel-config';
import { GATEWAY_HEADER } from '../../../src/services/node-websocket-gateway';

const root = join(import.meta.dirname, '../../../../../deploy/selfhost');
const frps = readFileSync(join(root, 'frps/frps.toml'), 'utf8');
const nodeWs = readFileSync(join(root, 'caddy/sam.d/node-ws.caddy'), 'utf8');
const frp = readFileSync(join(root, 'caddy/sam.d/frp.caddy'), 'utf8');

describe('frps.toml', () => {
  it('uses template braces only as frps environment lookups, never in comments', () => {
    // frps renders the WHOLE file as a Go template; a brace in a comment stops frps starting.
    for (const line of frps.split('\n')) {
      if (line.trimStart().startsWith('#')) expect(line).not.toContain('{{');
    }
    const lookups = frps.match(/\{\{[^}]*\}\}/g) ?? [];
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) expect(lookup).toMatch(/^\{\{ \.Envs\.[A-Z_]+ \}\}$/);
  });

  it('binds frps and every node proxy to loopback only', () => {
    expect(frps).toMatch(/^bindAddr = "127\.0\.0\.1"$/m);
    expect(frps).toMatch(/^proxyBindAddr = "127\.0\.0\.1"$/m);
    expect(frps).toMatch(/^maxPortsPerClient = 1$/m);
  });

  it('takes its heartbeat timeout from the value the deploy also gives the Worker', () => {
    expect(frps).toMatch(
      /^transport\.heartbeatTimeout = \{\{ \.Envs\.REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS \}\}$/m
    );
    // One default everywhere: box deploy script, Worker, and the frpc side cloud-init renders.
    expect(box.DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS).toBe(
      Number(REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS)
    );
    expect(box.DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS).toBe(
      config.DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS
    );
    expect(box.MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS).toBe(
      config.MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS
    );
    expect(box.MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS).toBe(
      config.MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS
    );
    expect(box.REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE).toBe(
      config.REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE
    );
    // gateway.env carries exactly the lookups the template reads.
    const gatewayEnv = box.renderGatewayEnv('ab'.repeat(32), box.resolveTunnelSettings({}));
    for (const lookup of frps.match(/\{\{ \.Envs\.([A-Z_]+) \}\}/g) ?? []) {
      const name = /Envs\.([A-Z_]+)/.exec(lookup)![1]!;
      if (['FRPS_BIND_PORT', 'CELLD_PORT'].includes(name)) continue; // docker-compose environment
      expect(gatewayEnv, name).toContain(`${name}=`);
    }
  });

  it('caps and defaults the lease range the same way on the box and in the Worker', () => {
    expect(box.MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE).toBe(config.MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE);
    expect(box.DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START).toBe(
      config.DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START
    );
    expect(box.DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END).toBe(
      config.DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END
    );
  });

  it('calls the Worker plugin route with basic auth for every op the Worker decides', () => {
    expect(frps).toContain('path = "/api/self-host/gateway/frps-plugin"');
    expect(frps).toContain(
      'addr = "http://frps:{{ .Envs.REVERSE_TUNNEL_GATEWAY_SECRET }}@127.0.0.1:{{ .Envs.CELLD_PORT }}"'
    );
    expect(frps).toContain(`ops = [${FRPS_PLUGIN_OPS.map((op) => `"${op}"`).join(', ')}]`);
  });
});

describe('Caddy fragments', () => {
  it('serves frp only on the API host and hides the internal gateway routes publicly', () => {
    expect(frp).toMatch(/host api\.\{\$SAM_DOMAIN\}\s+path \/~!frp/);
    expect(frp).toContain(
      '@sam_gateway_internal path /api/self-host/gateway /api/self-host/gateway/*'
    );
    expect(frp).toMatch(/handle @sam_gateway_internal \{\s+respond "Not found" 404/);
  });

  it('sends forward_auth to the gateway route with celld-safe forwarded headers', () => {
    const blocks = nodeWs.split('forward_auth 127.0.0.1').slice(1);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain('uri /api/self-host/gateway/node-websocket');
      // celld builds request.url from X-Forwarded-Host: it must name the API host.
      expect(block).toContain('header_up X-Forwarded-Host api.{$SAM_DOMAIN}');
      // The socket's host is captured before the Host override (header_up is unordered).
      expect(block).toContain(`header_up ${GATEWAY_ORIGINAL_HOST_HEADER} {vars.sam_ws_host}`);
      expect(block).toContain(
        `header_up ${GATEWAY_SECRET_HEADER} {$REVERSE_TUNNEL_GATEWAY_SECRET}`
      );
      const copied = /copy_headers (.+)/.exec(block)?.[1]?.split(' ') ?? [];
      const decisionHeaders = Object.values(GATEWAY_HEADER).filter(
        (h) => h !== GATEWAY_HEADER.decision
      );
      expect(new Set(copied)).toEqual(new Set(decisionHeaders));
    }
    expect(nodeWs.match(/vars sam_ws_host \{host\}/g)).toHaveLength(2);
    expect(nodeWs.match(/request_header -X-SAM-\*/g)).toHaveLength(2);
  });

  it('strips node cookies on port hosts for both ordinary and upgraded responses', () => {
    const portHandle = nodeWs.slice(
      nodeWs.indexOf('handle @sam_node_ws_port'),
      nodeWs.indexOf('@sam_node_ws {')
    );
    expect(portHandle).toContain('header_down -Set-Cookie');
    expect(portHandle).toMatch(/header \{\s+-Set-Cookie\s+match status 101\s+\}/);
  });
});
