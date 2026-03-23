/**
 * Integration test: workspace lifecycle synchronization.
 *
 * Verifies the wiring that ensures workspace status changes propagate
 * to chat sessions and that cleanup mechanisms actually clean up:
 *
 * 1. Stopping/deleting a workspace stops the chat session
 * 2. linkSessionToWorkspace creates workspace_activity and schedules alarm
 * 3. Orphaned workspaces are stopped by cron (not just flagged)
 * 4. Node destruction cascades workspace status to 'deleted'
 * 5. Credential lookup failure logs a warning
 *
 * Source contract test — verifies correct wiring across modules.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('workspace lifecycle synchronization', () => {
  const lifecycleFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/lifecycle.ts'), 'utf8');
  const crudFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/crud.ts'), 'utf8');
  const cleanupFile = readFileSync(resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'), 'utf8');
  const nodesFile = readFileSync(resolve(process.cwd(), 'src/services/nodes.ts'), 'utf8');
  const doFile = [
    readFileSync(resolve(process.cwd(), 'src/durable-objects/project-data/sessions.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/durable-objects/project-data/activity.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/durable-objects/project-data/index.ts'), 'utf8'),
  ].join('\n');

  describe('workspace stop → session stop synchronization', () => {
    it('stop route calls projectDataService.stopSession', () => {
      expect(lifecycleFile).toContain('projectDataService.stopSession');
      expect(lifecycleFile).toContain('workspace.stop_session_failed');
    });

    it('stop route cleans up workspace activity', () => {
      expect(lifecycleFile).toContain('projectDataService.cleanupWorkspaceActivity');
      expect(lifecycleFile).toContain('workspace.cleanup_activity_failed');
    });

    it('delete route calls projectDataService.stopSession', () => {
      expect(crudFile).toContain('projectDataService.stopSession');
      expect(crudFile).toContain('workspace.delete_stop_session_failed');
    });

    it('delete route cleans up workspace activity', () => {
      expect(crudFile).toContain('projectDataService.cleanupWorkspaceActivity');
      expect(crudFile).toContain('workspace.delete_cleanup_activity_failed');
    });
  });

  describe('task-driven workspace idle timeout fix', () => {
    it('linkSessionToWorkspace creates workspace_activity row', () => {
      // Implementation split across sessions.ts (SQL) and index.ts (delegation)
      expect(doFile).toContain('INSERT OR IGNORE INTO workspace_activity');
    });

    it('linkSessionToWorkspace calls recalculateAlarm', () => {
      expect(doFile).toContain('recalculateAlarm');
    });
  });

  describe('orphaned workspace cleanup (not just flagging)', () => {
    it('cron sweep stops orphaned workspaces on VM agent', () => {
      expect(cleanupFile).toContain('stopWorkspaceOnNode');
      expect(cleanupFile).toContain('node_cleanup.orphan_stop_on_node_failed');
    });

    it('cron sweep updates orphaned workspace status to stopped in D1', () => {
      expect(cleanupFile).toContain("status: 'stopped'");
      expect(cleanupFile).toContain('schema.workspaces');
      expect(cleanupFile).toContain('node_cleanup.orphaned_workspace_stopping');
    });

    it('cron sweep stops chat session for orphaned workspaces', () => {
      expect(cleanupFile).toContain('projectDataService.stopSession');
      expect(cleanupFile).toContain('node_cleanup.orphan_session_stop_failed');
    });

    it('cron sweep cleans up activity tracking for orphaned workspaces', () => {
      expect(cleanupFile).toContain('projectDataService.cleanupWorkspaceActivity');
      expect(cleanupFile).toContain('node_cleanup.orphan_activity_cleanup_failed');
    });
  });

  describe('node destruction cascade', () => {
    it('deleteNodeResources cascades workspace status to deleted', () => {
      const deleteSection = nodesFile.slice(
        nodesFile.indexOf('export async function deleteNodeResources(')
      );
      expect(deleteSection).toContain("status: 'deleted'");
      expect(deleteSection).toContain('schema.workspaces.nodeId');
    });

    it('deleteNodeResources logs warning when credentials are missing', () => {
      const deleteSection = nodesFile.slice(
        nodesFile.indexOf('export async function deleteNodeResources(')
      );
      expect(deleteSection).toContain('credential_missing_vm_orphaned');
    });
  });

  describe('cleanupWorkspaceActivity DO method', () => {
    it('ProjectData DO has cleanupWorkspaceActivity method', () => {
      expect(doFile).toContain('cleanupWorkspaceActivity(workspaceId: string)');
      expect(doFile).toContain('DELETE FROM workspace_activity WHERE workspace_id = ?');
    });
  });
});
