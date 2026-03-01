import { Link } from 'react-router-dom';
import type { Task } from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';

interface NeedsAttentionSectionProps {
  tasks: Task[];
  projectId: string;
}

export function NeedsAttentionSection({ tasks, projectId }: NeedsAttentionSectionProps) {
  const attention = tasks.filter(
    (task) => task.status === 'failed' || (task.status === 'ready' && task.blocked)
  );

  if (attention.length === 0) return null;

  return (
    <section className="border border-warning/40 rounded-md bg-warning-tint p-3 grid gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-warning-fg">
          Needs attention
        </span>
        <span className="text-xs font-semibold py-px px-2 rounded-full bg-warning-tint text-warning-fg">
          {attention.length}
        </span>
      </div>

      <ul className="m-0 p-0 list-none grid gap-1.5">
        {attention.map((task) => (
          <li
            key={task.id}
            className="flex items-center gap-2 flex-wrap"
          >
            <StatusBadge status={task.status} />
            {task.blocked && task.status !== 'failed' && (
              <span className="text-xs py-0.5 px-2 rounded-full bg-danger-tint text-danger-fg font-semibold">
                Blocked
              </span>
            )}
            <Link
              to={`/projects/${projectId}/tasks/${task.id}`}
              className="text-sm text-fg-primary no-underline"
            >
              {task.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
