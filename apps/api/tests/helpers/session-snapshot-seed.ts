/**
 * A verified session snapshot generation, as the capture writes it: the R2 objects it claims and
 * the `session_snapshots` row with its manifest. Shared by the sleep-fallback integration tests so
 * each seeds snapshots the same way.
 */
import type Database from 'better-sqlite3';

export const SNAPSHOT_BASE_COMMIT = 'a'.repeat(40);
export const SNAPSHOT_HOME_SHA256 = 'ab'.repeat(32);
export const SNAPSHOT_WIP_SHA256 = 'cd'.repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;

/** complete: HOME and WIP; home-skipped: WIP only (HOME over budget); wip-skipped: HOME only. */
export type SnapshotSeedMode = 'complete' | 'home-skipped' | 'wip-skipped';

export function seedSnapshotGeneration(
  sqlite: Database.Database,
  r2Objects: Map<string, { size: number; sha256: string | null }>,
  chatSessionId: string,
  workspaceId: string,
  generation: string,
  mode: SnapshotSeedMode
): void {
  const prefix = `session-snapshots/${chatSessionId}/${generation}`;
  const home = mode === 'complete' || mode === 'wip-skipped';
  const wip = mode === 'complete' || mode === 'home-skipped';
  if (home) r2Objects.set(`${prefix}/home.tar`, { size: 4, sha256: SNAPSHOT_HOME_SHA256 });
  if (wip) r2Objects.set(`${prefix}/wip.bundle`, { size: 9, sha256: SNAPSHOT_WIP_SHA256 });
  r2Objects.set(`${prefix}/manifest.json`, { size: 512, sha256: null });
  const status = mode === 'complete' ? 'available' : 'degraded';
  const degradation = mode === 'complete' ? 'none' : mode;
  sqlite
    .prepare(
      `UPDATE session_snapshots
       SET status = ?, degradation = ?, snapshot_generation = ?, capture_generation = NULL,
           capture_error = NULL, base_commit = ?,
           home_r2_key = ?, home_sha256 = ?, wip_r2_key = ?, wip_sha256 = ?,
           manifest_r2_key = ?, manifest_json = ?, expires_at = ?
       WHERE chat_session_id = ?`
    )
    .run(
      status,
      degradation,
      generation,
      SNAPSHOT_BASE_COMMIT,
      home ? `${prefix}/home.tar` : null,
      home ? SNAPSHOT_HOME_SHA256 : null,
      wip ? `${prefix}/wip.bundle` : null,
      wip ? SNAPSHOT_WIP_SHA256 : null,
      `${prefix}/manifest.json`,
      JSON.stringify({
        version: 1,
        chatSessionId,
        workspaceId,
        agentSessionId: workspaceId.replace('ws-', 'agent-'),
        acpSessionId: 'acp-1',
        agentType: 'claude-code',
        baseCommit: SNAPSHOT_BASE_COMMIT,
        git: {
          branch: 'sam/feature',
          upstream: 'origin/sam/feature',
          remote: 'origin',
          detached: false,
        },
        status,
        degradation,
        skipped: mode === 'complete' ? [] : [{ path: '$HOME', reason: 'budget exhausted' }],
        artifacts: {
          ...(home ? { home: { sizeBytes: 4, sha256: SNAPSHOT_HOME_SHA256 } } : {}),
          ...(wip ? { wip: { sizeBytes: 9, sha256: SNAPSHOT_WIP_SHA256 } } : {}),
        },
        createdAt: new Date().toISOString(),
      }),
      new Date(Date.now() + 7 * DAY_MS).toISOString(),
      chatSessionId
    );
}
