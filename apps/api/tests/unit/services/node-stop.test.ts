/**
 * Source contract tests for stopNodeResources (stop-node-marks-deleted).
 *
 * Verifies that stopping a node:
 * 1. Deletes the Hetzner server (not just powers off)
 * 2. Deletes the DNS record
 * 3. Marks node and workspaces as 'deleted' (not 'stopped')
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

  it('calls deleteServer instead of powerOffServer', () => {
    expect(section).toContain('deleteServer(');
    expect(section).not.toContain('powerOffServer(');
  });

  it('does not import powerOffServer', () => {
    const importLine = file.slice(0, file.indexOf('\n\n'));
    expect(importLine).not.toContain('powerOffServer');
    expect(importLine).toContain('deleteServer');
  });

  it('deletes DNS record', () => {
    expect(section).toContain('deleteDNSRecord(node.backendDnsRecordId');
  });

  it('marks workspaces as deleted', () => {
    expect(section).toContain("status: 'deleted'");
    // Ensure it does NOT use 'stopped' for workspaces
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
