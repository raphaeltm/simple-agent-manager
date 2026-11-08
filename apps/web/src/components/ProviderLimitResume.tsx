import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { resumeProviderLimitTask } from '../lib/api/tasks';
import { queryClient } from '../lib/query-client';

/** One explicit recovery action. Accepted wakes stay disabled until fresh server state arrives. */
export function ProviderLimitResume({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'waking'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    if (state !== 'idle') return;
    setState('pending');
    setError(null);
    try {
      await resumeProviderLimitTask(projectId, taskId);
      setState('waking');
      void queryClient.invalidateQueries();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to resume task. Try again.');
      setState('idle');
    }
  }

  return (
    <div className="min-w-0">
      <Button
        variant="accent"
        size="sm"
        className="min-h-14"
        disabled={state !== 'idle'}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void resume();
        }}
      >
        {state === 'pending' ? 'Resuming…' : state === 'waking' ? 'Waking…' : 'Resume task'}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger-fg break-words mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
