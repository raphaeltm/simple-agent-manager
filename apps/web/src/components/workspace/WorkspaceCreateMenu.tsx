import { useState, useEffect, useRef, type FC } from 'react';
import type { AgentInfo } from '@simple-agent-manager/shared';

interface WorkspaceCreateMenuProps {
  isMobile: boolean;
  sessionsLoading: boolean;
  configuredAgents: AgentInfo[];
  defaultAgentId: AgentInfo['id'] | null;
  defaultAgentName: string | null;
  onCreateTerminalTab: () => void;
  onCreateSession: (agentId?: AgentInfo['id']) => void;
}

export const WorkspaceCreateMenu: FC<WorkspaceCreateMenuProps> = ({
  isMobile,
  sessionsLoading,
  configuredAgents,
  defaultAgentId,
  defaultAgentName,
  onCreateTerminalTab,
  onCreateSession,
}) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current) return;
      const target = event.target as Node | null;
      if (target && !menuRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((prev) => !prev)}
        disabled={sessionsLoading}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: isMobile ? 42 : 36,
          height: '100%',
          background: 'none',
          border: 'none',
          borderLeft: '1px solid var(--sam-color-border-default)',
          color: 'var(--sam-color-tn-fg-muted)',
          cursor: sessionsLoading ? 'not-allowed' : 'pointer',
          fontSize: 18,
          fontWeight: 300,
          padding: 0,
          opacity: sessionsLoading ? 0.6 : 1,
        }}
        aria-label="Create terminal or chat session"
        aria-expanded={open}
      >
        +
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 220,
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            boxShadow: '0 10px 30px var(--sam-shadow-overlay)',
            zIndex: 'var(--sam-z-dropdown)' as unknown as number,
            overflow: 'hidden',
          }}
        >
          <button
            onClick={() => {
              onCreateTerminalTab();
              setOpen(false);
            }}
            disabled={sessionsLoading}
            style={{
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'transparent',
              color: 'var(--sam-color-fg-primary)',
              padding: isMobile ? '14px 16px' : '10px 12px',
              fontSize: isMobile
                ? 'var(--sam-type-secondary-size)'
                : 'var(--sam-type-caption-size)',
              cursor: sessionsLoading ? 'not-allowed' : 'pointer',
              opacity: sessionsLoading ? 0.65 : 1,
            }}
          >
            Terminal
          </button>

          {configuredAgents.length <= 1 ? (
            <button
              onClick={() => {
                onCreateSession(defaultAgentId ?? undefined);
                setOpen(false);
              }}
              disabled={configuredAgents.length === 0 || sessionsLoading}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color:
                  configuredAgents.length === 0 || sessionsLoading
                    ? 'var(--sam-color-fg-muted)'
                    : 'var(--sam-color-fg-primary)',
                padding: isMobile ? '14px 16px' : '10px 12px',
                fontSize: isMobile
                  ? 'var(--sam-type-secondary-size)'
                  : 'var(--sam-type-caption-size)',
                cursor:
                  configuredAgents.length === 0 || sessionsLoading ? 'not-allowed' : 'pointer',
                opacity: configuredAgents.length === 0 || sessionsLoading ? 0.65 : 1,
              }}
            >
              {defaultAgentName ?? 'Chat'}
            </button>
          ) : (
            configuredAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => {
                  onCreateSession(agent.id);
                  setOpen(false);
                }}
                disabled={sessionsLoading}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--sam-color-fg-primary)',
                  padding: isMobile ? '14px 16px' : '10px 12px',
                  fontSize: isMobile
                    ? 'var(--sam-type-secondary-size)'
                    : 'var(--sam-type-caption-size)',
                  cursor: sessionsLoading ? 'not-allowed' : 'pointer',
                  opacity: sessionsLoading ? 0.65 : 1,
                }}
              >
                {agent.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
