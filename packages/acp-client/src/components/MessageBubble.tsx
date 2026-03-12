import React from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import { MessageActions } from './MessageActions';

interface MessageBubbleProps {
  text: string;
  role: 'user' | 'agent';
  streaming?: boolean;
  /** Unix-millisecond timestamp for metadata display (agent messages only). */
  timestamp?: number;
}

// Stable remark plugins array — avoids creating a new array reference on every render
const REMARK_PLUGINS = [remarkGfm];

/** Syntax-highlighted fenced code block using prism-react-renderer. */
function HighlightedCode({ code, language }: { code: string; language: string }) {
  return (
    <Highlight theme={themes.nightOwl} code={code} language={language || 'text'}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          className="p-3 rounded-md overflow-x-auto text-xs whitespace-pre"
          style={{ margin: 0, background: '#011627', fontFamily: 'monospace', lineHeight: '1.5' }}
        >
          {tokens.map((line, lineIdx) => {
            const lineProps = getLineProps({ line });
            return (
              <div
                key={lineIdx}
                {...lineProps}
                style={{
                  ...lineProps.style,
                  display: 'flex',
                  padding: 0,
                  whiteSpace: 'pre',
                  minHeight: '1.5em',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: '2em',
                    textAlign: 'right',
                    paddingRight: '0.75em',
                    opacity: 0.4,
                    userSelect: 'none',
                    flexShrink: 0,
                    color: '#637777',
                  }}
                >
                  {lineIdx + 1}
                </span>
                <span style={{ flex: 1 }}>
                  {line.map((token, tokenIdx) => {
                    const tokenProps = getTokenProps({ token });
                    return <span key={tokenIdx} {...tokenProps} />;
                  })}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}

// Stable Markdown component overrides — hoisted to module scope so
// react-markdown sees the same component references across renders.
// This prevents unmount/remount of custom renderers which was destroying
// DOM nodes (resetting horizontal scroll position on code blocks).
const USER_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children ?? '').replace(/\n$/, '');
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
      <div className="my-2">
        <HighlightedCode code={code} language={match?.[1] ?? ''} />
      </div>
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
    const code = String(children ?? '').replace(/\n$/, '');
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
      <div className="my-2">
        <HighlightedCode code={code} language={match?.[1] ?? ''} />
      </div>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
      {children}
    </a>
  ),
};

/**
 * Renders a single message bubble with markdown support and syntax highlighting.
 * Agent messages are left-aligned, user messages are right-aligned.
 *
 * Wrapped in React.memo to prevent re-renders when parent state changes
 * (e.g., scroll position, input value) don't affect this component's props.
 */
export const MessageBubble = React.memo(function MessageBubble({ text, role, streaming, timestamp }: MessageBubbleProps) {
  const isUser = role === 'user';
  const isAgent = role === 'agent';
  const components = isUser ? USER_MARKDOWN_COMPONENTS : AGENT_MARKDOWN_COMPONENTS;
  const showActions = isAgent && !streaming && timestamp != null;

  return (
    <div className={`group/msg flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
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
        {showActions && (
          <div className="opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
            <MessageActions text={text} timestamp={timestamp} />
          </div>
        )}
      </div>
    </div>
  );
});
