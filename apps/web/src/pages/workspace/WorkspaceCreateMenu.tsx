import type { AgentInfo, AgentType } from '@simple-agent-manager/shared';
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

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
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const minWidth = 220;
    const gutter = 8;
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 6,
      left: Math.max(
        gutter,
        Math.min(rect.right - minWidth, window.innerWidth - minWidth - gutter)
      ),
      minWidth,
      borderRadius: 'var(--sam-radius-md)',
      border: '1px solid var(--sam-color-border-default)',
      boxShadow: '0 10px 30px var(--sam-shadow-overlay)',
      zIndex: 'var(--sam-z-dropdown)' as unknown as number,
      overflow: 'hidden',
    });
  }, []);

  useLayoutEffect(() => {
    if (!createMenuOpen) return;
    updateMenuPosition();

    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [createMenuOpen, updateMenuPosition]);

  const handleCreateTerminalTab = () => {
    onCreateTerminalTab();
    setCreateMenuOpen(false);
  };

  const handleCreateSession = (agentId?: AgentInfo['id']) => {
    onCreateSession(agentId);
    setCreateMenuOpen(false);
  };

  return (
    <div ref={createMenuRef} className="relative shrink-0">
      <button
        ref={buttonRef}
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

      {createMenuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="glass-surface"
            onMouseDown={(event) => event.stopPropagation()}
            style={menuStyle}
          >
            <button
              onClick={handleCreateTerminalTab}
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
                onClick={() => handleCreateSession(defaultAgentId ?? undefined)}
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
                  onClick={() => handleCreateSession(agent.id)}
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
          </div>,
          document.body
        )}
    </div>
  );
}
