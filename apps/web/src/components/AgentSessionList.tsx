import type { AgentSession } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';

interface AgentSessionListProps {
  sessions: AgentSession[];
  loading?: boolean;
  onCreate: () => void;
  onAttach: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

export function AgentSessionList({
  sessions,
  loading,
  onCreate,
  onAttach,
  onStop,
}: AgentSessionListProps) {
  return (
    <section
      style={{
        background: 'var(--sam-color-bg-surface)',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: 'var(--sam-space-3)',
          borderBottom: '1px solid var(--sam-color-border-default)',
        }}
      >
        <strong style={{ fontSize: '0.875rem' }}>Agent Sessions</strong>
        <Button size="sm" onClick={onCreate} disabled={loading}>
          New Session
        </Button>
      </div>

      {sessions.length === 0 ? (
        <div style={{ padding: 'var(--sam-space-3)', color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>
          No sessions yet.
        </div>
      ) : (
        <div>
          {sessions.map((session) => (
            <div
              key={session.id}
              style={{
                borderBottom: '1px solid var(--sam-color-border-default)',
                padding: 'var(--sam-space-3)',
                display: 'grid',
                gap: 'var(--sam-space-2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                  {session.label || session.id}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>{session.status}</span>
              </div>
              <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
                <Button size="sm" variant="secondary" onClick={() => onAttach(session.id)}>
                  Attach
                </Button>
                {session.status === 'running' && (
                  <Button size="sm" variant="danger" onClick={() => onStop(session.id)}>
                    Stop
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
