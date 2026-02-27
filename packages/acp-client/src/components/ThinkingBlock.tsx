import React, { useState } from 'react';

interface ThinkingBlockProps {
  text: string;
  active: boolean;
}

/**
 * Collapsible thinking/reasoning section.
 * Shows animated indicator while active, collapsed by default when complete.
 *
 * Wrapped in React.memo to prevent re-renders when parent state changes
 * don't affect this component's props.
 */
export const ThinkingBlock = React.memo(function ThinkingBlock({ text, active }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(active);

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center space-x-2 text-xs text-gray-500 hover:text-gray-700"
      >
        {active ? (
          <span className="animate-pulse">Thinking...</span>
        ) : (
          <span>Thought</span>
        )}
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && text && (
        <div className="mt-1 ml-4 p-2 bg-gray-50 border-l-2 border-gray-300 text-xs text-gray-600 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
});
