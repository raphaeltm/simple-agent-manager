/**
 * Source contract tests for stop-node-marks-deleted feature.
 *
 * Verifies that stopping a node:
 * 1. Deletes the Hetzner server (not just powers off)
 * 2. Deletes the DNS record
 * 3. Marks node and workspaces as 'deleted' (not 'stopped')
 * 4. All deletion paths use consistent 'deleted' terminal status
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('stopNodeResources source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/services/nodes.ts'), 'utf8');
  const section = file.slice(
    file.indexOf('export async function stopNodeResources'),
    file.indexOf('export async function deleteNodeResources')
  );

  it('calls provider.deleteVM instead of powerOffServer', () => {
    expect(section).toContain('provider.deleteVM(');
    expect(section).not.toContain('powerOffServer(');
  });

  it('uses createProvider from providers package', () => {
    const importLine = file.slice(0, file.indexOf('\n\n'));
    expect(importLine).not.toContain('powerOffServer');
    expect(importLine).toContain('createProvider');
  });

  it('deletes DNS record', () => {
    expect(section).toContain('deleteDNSRecord(node.backendDnsRecordId');
  });

  it('marks workspaces as deleted', () => {
    expect(section).toContain("status: 'deleted'");
    const workspaceUpdate = section.slice(
      section.indexOf('.update(schema.workspaces)'),
      section.indexOf('.update(schema.nodes)')
    );
    expect(workspaceUpdate).toContain("status: 'deleted'");
    expect(workspaceUpdate).not.toContain("status: 'stopped'");
  });

  it('marks node as deleted', () => {
    const nodeUpdate = section.slice(section.indexOf('.update(schema.nodes)'));
    expect(nodeUpdate).toContain("status: 'deleted'");
    expect(nodeUpdate).not.toContain("status: 'stopped'");
  });
});

describe('deleted status consistency across deletion paths', () => {
  it('requireNodeOwnership filters deleted nodes', () => {
    const authFile = readFileSync(resolve(process.cwd(), 'src/middleware/node-auth.ts'), 'utf8');
    expect(authFile).toContain("ne(nodes.status, 'deleted')");
  });

  it('node creation limit excludes deleted nodes', () => {
    const nodesFile = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
    const createSection = nodesFile.slice(
      nodesFile.indexOf("nodesRoutes.post('/',"),
      nodesFile.indexOf("nodesRoutes.get('/:id',")
    );
    expect(createSection).toContain("ne(schema.nodes.status, 'deleted')");
  });

  it('stop endpoint returns deleted status in response', () => {
    const nodesFile = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
    const stopSection = nodesFile.slice(
      nodesFile.indexOf("nodesRoutes.post('/:id/stop',"),
      nodesFile.indexOf("nodesRoutes.delete('/:id',")
    );
    expect(stopSection).toContain("c.json({ status: 'deleted' })");
  });

  it('cron cleanup marks destroyed nodes as deleted', () => {
    const cleanupFile = readFileSync(resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'), 'utf8');
    expect(cleanupFile).toContain("status: 'deleted'");
    expect(cleanupFile).not.toContain("status: 'stopped', warmSince: null");
  });

  it('cron lifetime guard skips deleted nodes', () => {
    const cleanupFile = readFileSync(resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'), 'utf8');
    // Layer 3 uses SQL filter to exclude stopped/deleted nodes
    expect(cleanupFile).toContain("n.status NOT IN ('stopped', 'deleted')");
  });

  it('task runner guards against deleted node status', () => {
    const taskRunner = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
    expect(taskRunner).toContain("node.status === 'deleted'");
  });

  it('getOwnedWorkspace rejects deleted workspaces', () => {
    const wsFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/_helpers.ts'), 'utf8');
    expect(wsFile).toContain("workspace.status === 'deleted'");
  });
});
