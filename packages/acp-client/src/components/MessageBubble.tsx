import React from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MessageBubbleProps {
  text: string;
  role: 'user' | 'agent';
  streaming?: boolean;
}

// Stable remark plugins array — avoids creating a new array reference on every render
const REMARK_PLUGINS = [remarkGfm];

// Stable Markdown component overrides — hoisted to module scope so
// react-markdown sees the same component references across renders.
// This prevents unmount/remount of custom renderers which was destroying
// DOM nodes (resetting horizontal scroll position on code blocks).
const USER_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    if (isInline) {
      return (
        <code
          className="bg-blue-500 text-blue-50 px-1 py-0.5 rounded text-xs font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <pre className="bg-gray-900 text-gray-100 p-3 rounded-md overflow-x-auto text-xs whitespace-pre">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
      {children}
    </a>
  ),
};

const AGENT_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    if (isInline) {
      return (
        <code
          className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <pre className="bg-gray-900 text-gray-100 p-3 rounded-md overflow-x-auto text-xs whitespace-pre">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
      {children}
    </a>
  ),
};

/**
 * Renders a single message bubble with markdown support.
 * Agent messages are left-aligned, user messages are right-aligned.
 *
 * Wrapped in React.memo to prevent re-renders when parent state changes
 * (e.g., scroll position, input value) don't affect this component's props.
 */
export const MessageBubble = React.memo(function MessageBubble({ text, role, streaming }: MessageBubbleProps) {
  const isUser = role === 'user';
  const components = isUser ? USER_MARKDOWN_COMPONENTS : AGENT_MARKDOWN_COMPONENTS;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-white border border-gray-200 text-gray-900'
        }`}
      >
        <div className="prose prose-sm max-w-none overflow-y-visible">
          <Markdown
            remarkPlugins={REMARK_PLUGINS}
            components={components}
          >
            {text}
          </Markdown>
        </div>
        {streaming && (
          <span className="inline-block mt-1 text-xs opacity-60 animate-pulse">...</span>
        )}
      </div>
    </div>
  );
});
