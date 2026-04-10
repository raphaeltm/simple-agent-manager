import type { AgentInfo, AgentType } from '@simple-agent-manager/shared';
import type { RefObject } from 'react';

export interface WorkspaceCreateMenuProps {
  createMenuRef: RefObject<HTMLDivElement | null>;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionsLoading: boolean;
  isMobile: boolean;
  configuredAgents: AgentInfo[];
  defaultAgentId: AgentType | null;
  defaultAgentName: string | null;
  onCreateTerminalTab: () => void;
  onCreateSession: (agentId?: AgentInfo['id']) => void;
}

export function WorkspaceCreateMenu({
  createMenuRef,
  createMenuOpen,
  setCreateMenuOpen,
  sessionsLoading,
  isMobile,
  configuredAgents,
  defaultAgentId,
  defaultAgentName,
  onCreateTerminalTab,
  onCreateSession,
}: WorkspaceCreateMenuProps) {
  return (
    <div ref={createMenuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setCreateMenuOpen((prev: boolean) => !prev)}
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
        aria-expanded={createMenuOpen}
      >
        +
      </button>

      {createMenuOpen && (
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
            type="button"
            onClick={onCreateTerminalTab}
            disabled={sessionsLoading}
            style={{
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'transparent',
              color: 'var(--sam-color-fg-primary)',
              padding: isMobile ? '14px 16px' : '10px 12px',
              fontSize: isMobile ? 'var(--sam-type-secondary-size)' : 'var(--sam-type-caption-size)',
              cursor: sessionsLoading ? 'not-allowed' : 'pointer',
              opacity: sessionsLoading ? 0.65 : 1,
            }}
          >
            Terminal
          </button>

          {configuredAgents.length <= 1 ? (
            <button
              type="button"
              onClick={() => onCreateSession(defaultAgentId ?? undefined)}
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
                fontSize: isMobile ? 'var(--sam-type-secondary-size)' : 'var(--sam-type-caption-size)',
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
                type="button"
                key={agent.id}
                onClick={() => onCreateSession(agent.id)}
                disabled={sessionsLoading}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--sam-color-fg-primary)',
                  padding: isMobile ? '14px 16px' : '10px 12px',
                  fontSize: isMobile ? 'var(--sam-type-secondary-size)' : 'var(--sam-type-caption-size)',
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
}
