import React from 'react';

import type { RawFallback } from '../hooks/useAcpMessages';

interface RawFallbackViewProps {
  item: RawFallback;
}

/**
 * Shared raw fallback rendering component used by both AgentPanel (workspace chat)
 * and ProjectMessageView (project chat) for display parity.
 *
 * Renders unknown/unsupported message types as a visible fallback with JSON content
 * rather than silently dropping them.
 */
export const RawFallbackView = React.memo(function RawFallbackView({ item }: RawFallbackViewProps) {
  return (
    <div className="my-2 border border-orange-200 bg-orange-50 rounded-lg p-3">
      <p className="text-xs text-orange-600 font-medium mb-1">Rich rendering unavailable</p>
      <pre className="text-xs text-gray-600 font-mono whitespace-pre-wrap overflow-auto max-h-40">
        {JSON.stringify(item.data, null, 2)}
      </pre>
    </div>
  );
});
