/** "Triggered by …" in the expanded session header, for chats an automation started. */
import type { TaskDetailResponse } from '@simple-agent-manager/shared';
import { Clock } from 'lucide-react';
import { Link } from 'react-router';

import { automationPaths } from '../../lib/automation-routes';

export function SessionTriggerOrigin({
  projectId,
  detail,
}: {
  projectId: string;
  detail: TaskDetailResponse;
}) {
  const { trigger, triggerExecution } = detail;
  if (!trigger) return null;
  const page = automationPaths.detail(projectId, 'trigger', trigger.id);
  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 rounded text-xs"
      style={{
        background: 'color-mix(in srgb, var(--sam-color-info, #3b82f6) 8%, transparent)',
      }}
    >
      <Clock
        size={12}
        className="shrink-0 mt-0.5"
        style={{ color: 'var(--sam-color-info, #3b82f6)' }}
      />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="font-medium text-fg-primary">Triggered by: {trigger.name}</div>
        {trigger.cronHumanReadable && (
          <div className="text-fg-muted">Schedule: {trigger.cronHumanReadable}</div>
        )}
        {triggerExecution && (
          <div className="text-fg-muted">Run #{triggerExecution.sequenceNumber}</div>
        )}
        <div className="flex items-center gap-2 mt-1">
          <Link to={page} className="text-accent-primary no-underline hover:underline">
            View automation
          </Link>
          <Link to={`${page}#runs`} className="text-fg-muted no-underline hover:underline">
            All runs
          </Link>
        </div>
      </div>
    </div>
  );
}
