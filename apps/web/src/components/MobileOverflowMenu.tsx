import { useState, useRef, useEffect } from 'react';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';

interface MobileOverflowMenuProps {
  repository?: string;
  branch?: string;
  isRunning: boolean;
  isStopped: boolean;
  agentType: string | null;
  sessionState: AcpSessionState;
  error: string | null;
  actionLoading: boolean;
  onStop: () => void;
  onRestart: () => void;
  onClearError: () => void;
}

/**
 * Overflow menu triggered by a vertical dots button in the mobile header.
 * Contains workspace info and actions that don't fit in the compact toolbar.
 */
export function MobileOverflowMenu({
  repository,
  branch,
  isRunning,
  isStopped,
  agentType,
  sessionState,
  error,
  actionLoading,
  onStop,
  onRestart,
  onClearError,
}: MobileOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const agentLabel = agentType ? agentStatusText(sessionState, agentType) : null;

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sam-color-fg-muted)',
          padding: '8px',
          display: 'flex',
          alignItems: 'center',
          minHeight: 44,
          minWidth: 44,
          justifyContent: 'center',
        }}
        aria-label="Workspace menu"
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99,
            }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: '100%',
              marginTop: 4,
              backgroundColor: 'var(--sam-color-bg-surface)',
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-lg, 8px)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              minWidth: 240,
              zIndex: 100,
              overflow: 'hidden',
            }}
          >
            {/* Repository info */}
            {repository && (
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--sam-color-border-default)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: 2 }}>Repository</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)', wordBreak: 'break-all' }}>
                  {repository}{branch ? `@${branch}` : ''}
                </div>
              </div>
            )}

            {/* Agent status */}
            {agentLabel && (
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--sam-color-border-default)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: sessionState === 'ready' ? '#4ade80' : sessionState === 'error' ? '#f87171' : '#fbbf24',
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)' }}>{agentLabel}</span>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--sam-color-border-default)' }}>
                <div style={{ fontSize: '0.8125rem', color: '#f87171', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ wordBreak: 'break-word' }}>{error}</span>
                  <button
                    onClick={() => { onClearError(); setOpen(false); }}
                    style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', padding: '4px 8px', fontSize: '0.75rem', flexShrink: 0 }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={{ padding: '8px' }}>
              {isRunning && (
                <button
                  onClick={() => { onStop(); setOpen(false); }}
                  disabled={actionLoading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '10px 12px',
                    background: 'none',
                    border: 'none',
                    borderRadius: 'var(--sam-radius-md, 6px)',
                    cursor: actionLoading ? 'not-allowed' : 'pointer',
                    color: '#f87171',
                    fontSize: '0.875rem',
                    textAlign: 'left',
                    opacity: actionLoading ? 0.5 : 1,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop Workspace
                </button>
              )}
              {isStopped && (
                <button
                  onClick={() => { onRestart(); setOpen(false); }}
                  disabled={actionLoading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '10px 12px',
                    background: 'none',
                    border: 'none',
                    borderRadius: 'var(--sam-radius-md, 6px)',
                    cursor: actionLoading ? 'not-allowed' : 'pointer',
                    color: 'var(--sam-color-accent-primary)',
                    fontSize: '0.875rem',
                    textAlign: 'left',
                    opacity: actionLoading ? 0.5 : 1,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                  </svg>
                  Restart Workspace
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function agentStatusText(state: AcpSessionState, agentType: string): string {
  switch (state) {
    case 'initializing': return `${agentType}: Initializing`;
    case 'ready': return `${agentType}: Ready`;
    case 'prompting': return `${agentType}: Working`;
    case 'error': return `${agentType}: Error`;
    case 'connecting': return `${agentType}: Connecting`;
    case 'reconnecting': return `${agentType}: Reconnecting`;
    default: return agentType;
  }
}
