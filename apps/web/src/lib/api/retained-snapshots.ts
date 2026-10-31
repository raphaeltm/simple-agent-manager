import { API_URL } from './client';

export type RetainedSnapshotArtifact = 'manifest' | 'wip';

/** Explicit owner download only: bytes never enter chat, telemetry, storage, or a model. */
export async function downloadRetainedSnapshot(
  projectId: string,
  sessionId: string,
  artifact: RetainedSnapshotArtifact
): Promise<void> {
  const artifactUrl = `${API_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/retained-snapshot/${artifact}`;
  const response = await fetch(artifactUrl, {
    method: 'HEAD',
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Saved work could not be downloaded');
  // Browser-native attachment handling avoids buffering a large WIP in phone memory.
  // The GET independently repeats all authorization/integrity checks after this preflight.
  const link = document.createElement('a');
  link.href = artifactUrl;
  link.download = `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${artifact === 'manifest' ? 'manifest.json' : 'wip.bundle'}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
