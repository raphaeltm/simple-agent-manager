import React from 'react';

import type { PlanItem } from '../hooks/useAcpMessages';

export interface StickyPlanButtonProps {
  plan: PlanItem | undefined;
  onClick: () => void;
}

/**
 * Floating button shown above the chat input when a plan exists.
 * Displays completion progress with a green glow and white text.
 */
export const StickyPlanButton: React.FC<StickyPlanButtonProps> = ({ plan, onClick }) => {
  if (!plan) return null;

  const completed = plan.entries.filter((e) => e.status === 'completed').length;
  const inProgress = plan.entries.some((e) => e.status === 'in_progress');
  const allDone = completed === plan.entries.length;
  const total = plan.entries.length;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontSize: '0.75rem',
        fontWeight: 500,
        borderRadius: 8,
        border: '1px solid rgba(34, 197, 94, 0.25)',
        backgroundColor: 'var(--sam-glass-bg-modal)',
        backdropFilter: 'blur(16px) saturate(1.35)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.35)',
        color: 'var(--sam-color-fg-primary)',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        boxShadow: inProgress
          ? '0 0 12px rgba(34, 197, 94, 0.3), 0 0 4px rgba(34, 197, 94, 0.15)'
          : allDone
            ? '0 0 12px rgba(34, 197, 94, 0.25)'
            : '0 0 6px rgba(34, 197, 94, 0.1)',
      }}
      title={`Plan: ${completed}/${total} complete`}
      aria-label={`View plan, ${completed} of ${total} steps complete`}
    >
      {/* Checklist icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(34, 197, 94, 0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
      <span>Plan</span>
      {/* Progress badge */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 6px',
          borderRadius: 4,
          fontSize: '0.75rem',
          fontWeight: 500,
          backgroundColor: allDone
            ? 'rgba(34, 197, 94, 0.2)'
            : 'rgba(34, 197, 94, 0.12)',
          color: allDone ? 'var(--sam-color-success-fg)' : 'var(--sam-color-fg-primary)',
        }}
      >
        {completed}/{total}
      </span>
      {/* Pulse dot when in progress */}
      {inProgress && (
        <span
          className="sam-status-pulse"
          style={{
            display: 'inline-block',
            height: 8,
            width: 8,
            borderRadius: '50%',
            backgroundColor: '#22c55e',
          }}
        />
      )}
    </button>
  );
};
