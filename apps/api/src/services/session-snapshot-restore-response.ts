/**
 * What the vm-agent's `restoreSessionSnapshot`
 * (`packages/vm-agent/internal/server/session_snapshot_restore.go`) receives when it
 * wakes a sleeping chat: `GET /api/workspaces/:id/session-snapshot/restore`.
 *
 * After a bounded sleep fallback the saved agent context is older than the
 * conversation, because the session kept going after its recovery point was captured.
 * So the response leaves the manifest's `acpSessionId` out. The vm-agent still restores
 * the files and the Git state, but `snapshotHarnessResumeIdentity` then finds no
 * resumable agent context, the restore reports `degraded`, and `startSamAwareAgentSession`
 * starts the agent fresh with the fallback wake prompt instead of loading the stale
 * session. Every deployed vm-agent already handles a manifest without an agent session
 * this way, and reads the resume identity only from this response, so no agent upgrade
 * is needed.
 */
import type * as schema from '../db/schema';
import type { Env } from '../env';
import { sleptFallbackRecord } from './session-sleep-episode';
import { getSessionSnapshotConfig } from './session-snapshot-artifacts';

type RestoreArtifact = 'home' | 'wip' | 'manifest';

function restoreManifest(snapshot: schema.SessionSnapshot): unknown {
  if (!snapshot.manifestJson) return null;
  const manifest: unknown = JSON.parse(snapshot.manifestJson);
  if (
    !sleptFallbackRecord(snapshot) ||
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return manifest;
  }
  const withoutAgentSession: Record<string, unknown> = { ...manifest };
  delete withoutAgentSession.acpSessionId;
  return withoutAgentSession;
}

export function sessionSnapshotRestoreResponse(
  env: Env,
  workspaceId: string,
  chatSessionId: string,
  snapshot: schema.SessionSnapshot
) {
  const artifactPath = (artifact: RestoreArtifact) =>
    `/api/workspaces/${workspaceId}/session-snapshot/artifacts/${artifact}?chatSessionId=${encodeURIComponent(chatSessionId)}`;
  return {
    available: true,
    status: snapshot.status,
    degradation: snapshot.degradation,
    baseCommit: snapshot.baseCommit,
    manifest: restoreManifest(snapshot),
    config: getSessionSnapshotConfig(env),
    download: {
      home: snapshot.homeR2Key ? artifactPath('home') : null,
      wip: snapshot.wipR2Key ? artifactPath('wip') : null,
      manifest: artifactPath('manifest'),
    },
  };
}
