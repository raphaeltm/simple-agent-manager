import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { resumeProviderLimitTask, startProviderLimitTaskAnyway } from '../lib/api/tasks';
import { queryClient } from '../lib/query-client';

const ACTIONS = {
  resume: {
    run: resumeProviderLimitTask,
    idle: 'Resume task',
    pending: 'Resuming…',
    done: 'Waking…',
    failed: 'Unable to resume task. Try again.',
  },
  'resume-anyway': {
    run: startProviderLimitTaskAnyway,
    idle: 'Resume anyway',
    pending: 'Resuming…',
    done: 'Waking…',
    failed: 'Unable to resume this session. Try again.',
  },
  'start-anyway': {
    run: startProviderLimitTaskAnyway,
    idle: 'Start anyway',
    pending: 'Starting…',
    done: 'Starting…',
    failed: 'Unable to start task. Try again.',
  },
} as const;

/**
 * One explicit owner action on a provider-limit hold: resume a blocked wait, or start a
 * never-started task or resume a saved waiting session despite the limit. Accepted actions stay disabled until fresh
 * server state arrives.
 */
export function ProviderLimitResume({
  projectId,
  taskId,
  action = 'resume',
}: {
  projectId: string;
  taskId: string;
  action?: keyof typeof ACTIONS;
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const copy = ACTIONS[action];

  async function run() {
    if (state !== 'idle') return;
    setState('pending');
    setError(null);
    try {
      await copy.run(projectId, taskId);
      setState('done');
      void queryClient.invalidateQueries();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
      setState('idle');
    }
  }

  return (
    <div className="min-w-0 sm:max-w-64">
      <Button
        variant="accent"
        size="sm"
        className="min-h-14"
        disabled={state !== 'idle'}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void run();
        }}
      >
        {state === 'pending' ? copy.pending : state === 'done' ? copy.done : copy.idle}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger-fg break-words mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
