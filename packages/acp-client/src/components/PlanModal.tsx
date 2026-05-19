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
 */
export const PlanModal: React.FC<PlanModalProps> = ({ plan, isOpen, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap + Escape key
  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus();
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
      {/* Backdrop with blur */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          transition: 'opacity 0.15s',
        }}
        onClick={onClose}
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
            backgroundColor: 'rgba(8, 15, 12, 0.55)',
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(34, 197, 94, 0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e6f2ee', margin: 0 }}>Plan</h3>
              <span style={{ fontSize: '0.75rem', color: '#9fb7ae' }}>{completed} of {total} complete</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: 4,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: '#9fb7ae',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-label="Close plan"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Plan entries */}
          <div style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {plan.entries.map((entry, idx) => (
                <li key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.875rem' }}>
                  <span
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
                      color: entry.status === 'completed' ? '#9fb7ae' : '#e6f2ee',
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
            <div style={{ height: 6, backgroundColor: 'rgba(34, 197, 94, 0.1)', borderRadius: 9999, overflow: 'hidden' }}>
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
