import type { AcpSessionState } from '@simple-agent-manager/acp-client';

type ViewMode = 'terminal' | 'conversation';

interface MobileBottomBarProps {
  viewMode: ViewMode;
  onChangeView: (mode: ViewMode) => void;
  onOpenAgentSheet: () => void;
  agentType: string | null;
  sessionState: AcpSessionState;
  isRunning: boolean;
}

/**
 * Fixed bottom navigation bar for mobile workspace view.
 * Provides thumb-friendly 56px touch targets for Terminal, Chat, and Agent.
 */
export function MobileBottomBar({
  viewMode,
  onChangeView,
  onOpenAgentSheet,
  agentType,
  sessionState,
  isRunning,
}: MobileBottomBarProps) {
  if (!isRunning) return null;

  const agentReady = sessionState === 'ready' || sessionState === 'prompting';
  const agentActive = !!agentType;

  return (
    <nav className="sam-mobile-bottom-bar" aria-label="Workspace navigation">
      {/* Terminal tab */}
      <button
        className={`sam-mobile-tab ${viewMode === 'terminal' ? 'sam-mobile-tab--active' : ''}`}
        onClick={() => onChangeView('terminal')}
        aria-current={viewMode === 'terminal' ? 'page' : undefined}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span className="sam-mobile-tab__label">Terminal</span>
      </button>

      {/* Chat tab */}
      <button
        className={`sam-mobile-tab ${viewMode === 'conversation' ? 'sam-mobile-tab--active' : ''}`}
        onClick={() => onChangeView('conversation')}
        aria-current={viewMode === 'conversation' ? 'page' : undefined}
      >
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          {/* Activity dot when agent is active */}
          {agentActive && (
            <span
              style={{
                position: 'absolute',
                top: -2,
                right: -4,
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: agentReady ? '#4ade80' : '#fbbf24',
              }}
            />
          )}
        </span>
        <span className="sam-mobile-tab__label">Chat</span>
      </button>

      {/* Agent tab */}
      <button
        className="sam-mobile-tab"
        onClick={onOpenAgentSheet}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z" />
        </svg>
        <span className="sam-mobile-tab__label">Agent</span>
      </button>
    </nav>
  );
}
