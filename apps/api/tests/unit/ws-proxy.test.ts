import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ws proxy source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('routes workspace traffic via node backend hostname', () => {
    expect(file).toContain('${routedNodeId}.vm.${baseDomain}');
    expect(file).toContain('workspace.nodeId || workspaceId');
  });

  it('does not block proxying when workspace vmIp is null', () => {
    expect(file).not.toContain('!workspace || !workspace.vmIp');
    expect(file).toContain("return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);");
  });

  it('strips spoofed routing headers and injects trusted values', () => {
    expect(file).toContain("headers.delete('x-sam-node-id')");
    expect(file).toContain("headers.delete('x-sam-workspace-id')");
    expect(file).toContain("headers.set('X-SAM-Node-Id'");
    expect(file).toContain("headers.set('X-SAM-Workspace-Id'");
  });

  it('allows recovery workspaces to proxy traffic', () => {
    expect(file).toContain("workspace.status !== 'running' && workspace.status !== 'recovery'");
  });

  it('constructs the backend VM URL from trusted routing config instead of cloning request origin', () => {
    expect(file).toContain('new URL(`${vmAgentProtocol}://${backendHostname}:${vmAgentPort}`)');
    expect(file).not.toContain('const vmUrl = new URL(c.req.url)');
  });

  it('constructs the container proxy URL from trusted localhost config instead of cloning request origin', () => {
    expect(file).toContain('new URL(`http://localhost:${vmAgentPort}`)');
    expect(file).not.toContain('const containerUrl = new URL(c.req.url)');
  });

  it('strips client-supplied X-Forwarded-Host and sets trusted value', () => {
    expect(file).toContain("headers.delete('x-forwarded-host')");
    expect(file).toContain("headers.set('X-Forwarded-Host', hostname)");
    expect(file).toContain("headers.set('X-Forwarded-Proto', 'https')");
  });
});
