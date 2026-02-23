import React from 'react';
import type { PlanItem } from '../hooks/useAcpMessages';

export interface StickyPlanButtonProps {
  plan: PlanItem | undefined;
  onClick: () => void;
}

/**
 * Floating button shown above the chat input when a plan exists.
 * Displays completion progress and pulses when work is in progress.
 */
export const StickyPlanButton: React.FC<StickyPlanButtonProps> = ({ plan, onClick }) => {
  if (!plan) return null;

  const completed = plan.entries.filter((e) => e.status === 'completed').length;
  const inProgress = plan.entries.some((e) => e.status === 'in_progress');
  const allDone = completed === plan.entries.length;
  const total = plan.entries.length;

  // Border/glow color based on aggregate status
  const borderClass = allDone
    ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
    : inProgress
      ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
      : 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center space-x-2 px-3 py-1.5 mb-2 text-xs font-medium rounded-md border transition-colors ${borderClass}`}
      title={`Plan: ${completed}/${total} complete`}
      aria-label={`View plan, ${completed} of ${total} steps complete`}
    >
      {/* Checklist icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
      <span>Plan</span>
      {/* Progress badge */}
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
        allDone ? 'bg-green-200 text-green-800' :
        inProgress ? 'bg-blue-200 text-blue-800' : 'bg-gray-200 text-gray-700'
      }`}>
        {completed}/{total}
      </span>
      {/* Pulse dot when in progress */}
      {inProgress && (
        <span className="inline-block h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
      )}
    </button>
  );
};
