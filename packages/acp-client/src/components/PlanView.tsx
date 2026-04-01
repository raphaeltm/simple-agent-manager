import React from 'react';

import type { PlanItem } from '../hooks/useAcpMessages';

interface PlanViewProps {
  plan: PlanItem;
}

/**
 * Shared plan rendering component used by both AgentPanel (workspace chat)
 * and ProjectMessageView (project chat) for display parity.
 */
export const PlanView = React.memo(function PlanView({ plan }: PlanViewProps) {
  return (
    <div className="my-2 border border-gray-200 rounded-lg p-3 bg-white">
      <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Plan</h4>
      <ul className="space-y-1">
        {plan.entries.map((entry, idx) => (
          <li key={idx} className="flex items-center space-x-2 text-sm">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                entry.status === 'completed'
                  ? 'bg-green-400'
                  : entry.status === 'in_progress'
                    ? 'bg-blue-400 animate-pulse'
                    : 'bg-gray-300'
              }`}
            />
            <span
              className={
                entry.status === 'completed'
                  ? 'line-through text-gray-400'
                  : 'text-gray-700'
              }
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
