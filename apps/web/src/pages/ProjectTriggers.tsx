import type { TriggerResponse, UpdateTriggerRequest } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { Clock, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { TriggerCard } from '../components/triggers/TriggerCard';
import { TriggerForm } from '../components/triggers/TriggerForm';
import { useToast } from '../hooks/useToast';
import { listTriggers, runTrigger, updateTrigger } from '../lib/api';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ProjectTriggers() {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();
  const toast = useToast();

  const [triggers, setTriggers] = useState<TriggerResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TriggerResponse | null>(null);

  const loadTriggers = useCallback(async () => {
    try {
      const resp = await listTriggers(projectId);
      setTriggers(resp.triggers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load triggers');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTriggers();
  }, [loadTriggers]);

  const handleRunNow = useCallback(async (trigger: TriggerResponse) => {
    try {
      await runTrigger(projectId, trigger.id);
      toast.success(`"${trigger.name}" triggered`);
      void loadTriggers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run trigger');
    }
  }, [projectId, toast, loadTriggers]);

  const handleTogglePause = useCallback(async (trigger: TriggerResponse) => {
    const newStatus = trigger.status === 'paused' ? 'active' : 'paused';
    try {
      const data: UpdateTriggerRequest = { status: newStatus };
      await updateTrigger(projectId, trigger.id, data);
      toast.success(`"${trigger.name}" ${newStatus === 'active' ? 'resumed' : 'paused'}`);
      void loadTriggers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update trigger');
    }
  }, [projectId, toast, loadTriggers]);

  const handleEdit = useCallback((trigger: TriggerResponse) => {
    setEditTarget(trigger);
    setFormOpen(true);
  }, []);

  const handleViewHistory = useCallback((trigger: TriggerResponse) => {
    navigate(`/projects/${projectId}/triggers/${trigger.id}`);
  }, [navigate, projectId]);

  const handleNewTrigger = useCallback(() => {
    setEditTarget(null);
    setFormOpen(true);
  }, []);

  // Loading
  if (loading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-danger mb-4">{error}</p>
        <button
          onClick={() => { setLoading(true); void loadTriggers(); }}
          className={`px-4 py-2 text-sm font-medium text-accent bg-transparent border border-border-default rounded-md cursor-pointer ${FOCUS_RING}`}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="sam-type-page-title m-0">Triggers</h1>
          <p className="sam-type-secondary text-fg-muted mt-1 mb-0">
            Automated schedules that run tasks on a recurring basis
          </p>
        </div>
        <button
          onClick={handleNewTrigger}
          className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-accent text-white rounded-md hover:bg-accent/90 cursor-pointer border-none ${FOCUS_RING}`}
        >
          <Plus size={16} aria-hidden="true" />
          New Trigger
        </button>
      </div>

      {/* Trigger list or empty state */}
      {triggers.length === 0 ? (
        <EmptyState onCreateTrigger={handleNewTrigger} />
      ) : (
        <div className="space-y-3">
          {triggers.map((trigger) => (
            <TriggerCard
              key={trigger.id}
              trigger={trigger}
              onEdit={handleEdit}
              onRunNow={handleRunNow}
              onTogglePause={handleTogglePause}
              onViewHistory={handleViewHistory}
            />
          ))}
        </div>
      )}

      {/* Creation/edit form */}
      <TriggerForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditTarget(null); }}
        editTrigger={editTarget}
        onSaved={loadTriggers}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCreateTrigger }: { onCreateTrigger: () => void }) {
  return (
    <div className="text-center py-16 border border-border-default border-dashed rounded-lg">
      <Clock size={48} className="mx-auto mb-4 text-fg-muted opacity-50" />
      <h2 className="sam-type-card-title m-0">No triggers yet</h2>
      <p className="sam-type-secondary text-fg-muted mt-2 mb-4 max-w-sm mx-auto">
        Create a trigger to automatically run tasks on a schedule.
        Triggers use cron expressions to define when they fire.
      </p>
      <button
        onClick={onCreateTrigger}
        className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-accent text-white rounded-md hover:bg-accent/90 cursor-pointer border-none ${FOCUS_RING}`}
      >
        <Plus size={16} aria-hidden="true" />
        Create your first trigger
      </button>
    </div>
  );
}
