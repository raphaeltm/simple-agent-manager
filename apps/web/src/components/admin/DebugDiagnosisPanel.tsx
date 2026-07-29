import type { DebugDiagnosis, DebugProjectOption } from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import { fetchAdminDebugProjects, saveAdminDebugDiagnosisAsIdea } from '../../lib/api';

interface Props {
  diagnosis: DebugDiagnosis | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

export function DebugDiagnosisPanel({ diagnosis, loading, error, onClose }: Props) {
  const [projects, setProjects] = useState<DebugProjectOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [ideaId, setIdeaId] = useState<string | null>(diagnosis?.ideaId ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setIdeaId(diagnosis?.ideaId ?? null);
    setSaveError(null);
    if (!diagnosis || diagnosis.ideaId) return;
    fetchAdminDebugProjects().then(({ projects: options }) => {
      setProjects(options);
      setProjectId(options[0]?.id ?? '');
    }).catch((cause) => {
      setSaveError(cause instanceof Error ? cause.message : 'Failed to load projects');
    });
  }, [diagnosis]);

  if (!loading && !error && !diagnosis) return null;

  const saveIdea = async () => {
    if (!diagnosis || !projectId) return;
    setSaving(true);
    setSaveError(null);
    try {
      setIdeaId((await saveAdminDebugDiagnosisAsIdea(diagnosis.id, { projectId })).ideaId);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Failed to save draft Idea');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-4">
      <div className="flex items-start justify-between gap-3 border-b border-border-default p-4">
        <div>
          <h2 className="m-0 text-base font-semibold text-fg-primary">Deployment diagnosis</h2>
          <Body className="mt-1 text-fg-muted">
            Read-only analysis of bounded error evidence and related deployment state.
          </Body>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {loading && (
        <div className="flex items-center gap-3 p-6 text-sm text-fg-muted" aria-live="polite">
          <Spinner size="sm" /> Inspecting recent evidence…
        </div>
      )}
      {error && <div className="m-4 rounded-sm bg-danger-tint p-3 text-sm text-danger-fg">{error}</div>}
      {diagnosis && (
        <div className="space-y-4 p-4">
          <pre className="m-0 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-4 font-sans text-sm leading-relaxed text-fg-primary">
            {diagnosis.diagnosis}
          </pre>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            <span>Model: {diagnosis.model}</span>
            <span>Turns: {diagnosis.usage.turns}</span>
            <span>Run tokens: {diagnosis.usage.totalTokens.toLocaleString()}</span>
            <span>Daily: {diagnosis.usage.dailyTokensUsed.toLocaleString()} / {diagnosis.usage.dailyTokenLimit.toLocaleString()}</span>
          </div>
          {ideaId ? (
            <div className="rounded-sm bg-success-tint p-3 text-sm text-success-fg">
              Saved as draft Idea {ideaId}.
            </div>
          ) : (
            <div className="flex flex-col gap-2 border-t border-border-default pt-4 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-fg-muted">
                Save diagnosis to project
                <select
                  className="min-h-9 rounded-sm border border-border-default bg-surface px-3 text-sm text-fg-primary"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
              <Button size="sm" variant="secondary" disabled={!projectId || saving} onClick={saveIdea}>
                {saving ? 'Saving…' : 'Save as draft Idea'}
              </Button>
            </div>
          )}
          {saveError && <div className="text-sm text-danger-fg">{saveError}</div>}
        </div>
      )}
    </Card>
  );
}
