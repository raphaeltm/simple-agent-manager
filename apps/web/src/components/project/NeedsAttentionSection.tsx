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
    <section
      style={{
        border: '1px solid rgba(245, 158, 11, 0.4)',
        borderRadius: 'var(--sam-radius-md)',
        background: 'rgba(245, 158, 11, 0.06)',
        padding: 'var(--sam-space-3)',
        display: 'grid',
        gap: 'var(--sam-space-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#fbbf24' }}>
          Needs attention
        </span>
        <span style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          padding: '1px 7px',
          borderRadius: '9999px',
          background: 'rgba(245, 158, 11, 0.2)',
          color: '#fbbf24',
        }}>
          {attention.length}
        </span>
      </div>

      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.375rem' }}>
        {attention.map((task) => (
          <li
            key={task.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sam-space-2)',
              flexWrap: 'wrap',
            }}
          >
            <StatusBadge status={task.status} />
            {task.blocked && task.status !== 'failed' && (
              <span style={{
                fontSize: '0.75rem',
                padding: '2px 7px',
                borderRadius: '9999px',
                background: 'rgba(239,68,68,0.15)',
                color: '#f87171',
                fontWeight: 600,
              }}>
                Blocked
              </span>
            )}
            <Link
              to={`/projects/${projectId}/tasks/${task.id}`}
              style={{
                fontSize: '0.875rem',
                color: 'var(--sam-color-fg-primary)',
                textDecoration: 'none',
              }}
            >
              {task.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
