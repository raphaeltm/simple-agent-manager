import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ws proxy source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('routes workspace traffic via node backend hostname', () => {
    expect(file).toContain('vm-${routedNodeId}.${baseDomain}');
    expect(file).toContain('workspace.nodeId || workspaceId');
  });

  it('strips spoofed routing headers and injects trusted values', () => {
    expect(file).toContain("headers.delete('x-sam-node-id')");
    expect(file).toContain("headers.delete('x-sam-workspace-id')");
    expect(file).toContain("headers.set('X-SAM-Node-Id'");
    expect(file).toContain("headers.set('X-SAM-Workspace-Id'");
  });
});
