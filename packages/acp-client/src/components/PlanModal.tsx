import { CheckSquare, X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';

import type { PlanItem } from '../hooks/useAcpMessages';

export interface PlanModalProps {
  plan: PlanItem;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal overlay showing the full agent plan with status indicators.
 * Uses the glassmorphic design system: dark glass background, green accents, strong blur.
 *
 * Focus behavior: focuses the dialog container on open, restores focus on close,
 * closes on Escape and backdrop click. Prevents body scroll while open.
 */
export const PlanModal: React.FC<PlanModalProps> = ({ plan, isOpen, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Focus dialog on open; restore focus on close
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  if (!isOpen) return null;

  const completed = plan.entries.filter((e) => e.status === 'completed').length;
  const total = plan.entries.length;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50 }}
      role="dialog"
      aria-modal="true"
      aria-label="Agent plan progress"
    >
      {/* Backdrop with blur — button for keyboard/lint compliance */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close plan overlay"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--sam-glass-backdrop-dim)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          transition: 'opacity 0.15s',
          border: 'none',
          padding: 0,
          cursor: 'default',
        }}
        tabIndex={-1}
      />

      {/* Centered modal */}
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div
          ref={dialogRef}
          tabIndex={-1}
          style={{
            position: 'relative',
            maxWidth: 480,
            width: '100%',
            outline: 'none',
            backgroundColor: 'var(--sam-glass-bg-modal)',
            backdropFilter: 'blur(24px) saturate(1.35)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.35)',
            border: '1px solid rgba(34, 197, 94, 0.12)',
            borderRadius: 14,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid rgba(34, 197, 94, 0.12)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckSquare size={16} style={{ color: 'rgba(34, 197, 94, 0.7)' }} />
              <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)', margin: 0 }}>Plan</h3>
              <span style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>{completed} of {total} complete</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: 4,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: 'var(--sam-color-fg-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-label="Close plan"
            >
              <X size={16} />
            </button>
          </div>

          {/* Plan entries */}
          <div style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {plan.entries.map((entry, idx) => (
                <li key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.875rem' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      height: 10,
                      width: 10,
                      borderRadius: '50%',
                      marginTop: 5,
                      flexShrink: 0,
                      backgroundColor:
                        entry.status === 'completed' ? '#22c55e' :
                        entry.status === 'in_progress' ? '#22c55e' : '#4a6a60',
                      boxShadow: entry.status === 'in_progress' ? '0 0 8px rgba(34, 197, 94, 0.6)' : 'none',
                      animation: entry.status === 'in_progress' ? 'glowPulse 2s ease-in-out infinite' : 'none',
                    }}
                  />
                  <span
                    style={{
                      color: entry.status === 'completed' ? 'var(--sam-color-fg-muted)' : 'var(--sam-color-fg-primary)',
                      textDecoration: entry.status === 'completed' ? 'line-through' : 'none',
                      opacity: entry.status === 'completed' ? 0.7 : 1,
                    }}
                  >
                    {entry.content}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Progress bar */}
          <div style={{ padding: '0 16px 12px' }}>
            <div
              role="progressbar"
              aria-valuenow={completed}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-label={`Plan progress: ${completed} of ${total} complete`}
              style={{ height: 6, backgroundColor: 'rgba(34, 197, 94, 0.1)', borderRadius: 9999, overflow: 'hidden' }}
            >
              <div
                style={{
                  height: '100%',
                  backgroundColor: '#22c55e',
                  borderRadius: 9999,
                  transition: 'width 0.3s ease',
                  width: total > 0 ? `${(completed / total) * 100}%` : '0%',
                  boxShadow: '0 0 8px rgba(34, 197, 94, 0.4)',
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
