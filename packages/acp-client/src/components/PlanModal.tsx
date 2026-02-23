import React, { useEffect, useRef } from 'react';
import type { PlanItem } from '../hooks/useAcpMessages';

export interface PlanModalProps {
  plan: PlanItem;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal overlay showing the full agent plan with status indicators.
 * Follows the ConfirmDialog pattern: fixed backdrop, Escape to close, focus trap.
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
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', transition: 'opacity 0.15s' }}
        onClick={onClose}
      />

      {/* Centered modal */}
      <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="bg-white rounded-lg shadow-xl border border-gray-200"
          style={{ position: 'relative', maxWidth: 480, width: '100%', outline: 'none' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <div className="flex items-center space-x-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <h3 className="text-sm font-semibold text-gray-800">Plan</h3>
              <span className="text-xs text-gray-500">{completed} of {total} complete</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Close plan"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Plan entries */}
          <div className="px-4 py-3 overflow-y-auto" style={{ maxHeight: '60vh' }}>
            <ul className="space-y-2">
              {plan.entries.map((entry, idx) => (
                <li key={idx} className="flex items-start space-x-2.5 text-sm">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full mt-1.5 flex-shrink-0 ${
                    entry.status === 'completed' ? 'bg-green-400' :
                    entry.status === 'in_progress' ? 'bg-blue-400 animate-pulse' : 'bg-gray-300'
                  }`} />
                  <span className={entry.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-700'}>
                    {entry.content}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Progress bar */}
          <div className="px-4 pb-3">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: total > 0 ? `${(completed / total) * 100}%` : '0%' }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
