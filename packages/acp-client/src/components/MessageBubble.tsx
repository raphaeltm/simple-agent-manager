import { Highlight, themes } from 'prism-react-renderer';
import React, { useMemo } from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { MessageActions } from './MessageActions';

interface MessageBubbleProps {
  text: string;
  role: 'user' | 'agent';
  streaming?: boolean;
  /** Unix-millisecond timestamp for metadata display. */
  timestamp?: number;
  /** TTS API base URL for server-side text-to-speech (e.g., "https://api.example.com/api/tts"). */
  ttsApiUrl?: string;
  /** Unique storage ID for caching TTS audio (e.g., message ID). */
  ttsStorageId?: string;
  /** Optional callback to delegate audio playback to a global player. */
  onPlayAudio?: () => void;
  /** Optional callback when a file path link is clicked. Receives path and optional line number. */
  onFileClick?: (path: string, line?: number | null) => void;
}

// Stable remark plugins array — avoids creating a new array reference on every render
const REMARK_PLUGINS = [remarkGfm];

/**
 * Detect whether a markdown link href looks like a file path rather than a URL.
 * File paths are routed to the file browser instead of opening a new window.
 */
export function isFilePathHref(href: string | undefined): boolean {
  if (!href) return false;
  // URLs, anchors, and special protocols are not file paths
  if (/^(https?:|ftp:|wss?:|file:|mailto:|#|javascript:|tel:|data:|blob:)/i.test(href)) return false;
  // Bare hostnames without protocol (e.g., www.example.com, docs.example.com) are URLs, not file paths
  if (/^(www\.|([a-z0-9-]+\.)+?(com|org|net|io|dev|app|co|edu|gov)\b)/i.test(href)) return false;
  // Must contain a dot (extension) or a slash (path separator) to look like a file path
  // Examples: src/main.ts, ./foo/bar.js, package.json, README.md
  return /[./]/.test(href);
}

/**
 * Parse a file path reference that may include a line number suffix.
 * Examples: "src/main.ts:42" → { path: "src/main.ts", line: 42 }
 *           "src/main.ts" → { path: "src/main.ts", line: null }
 */
export function parseFilePathRef(ref: string): { path: string; line: number | null } {
  const match = ref.match(/^(.+?):(\d+)$/);
  if (match) {
    return { path: match[1]!, line: parseInt(match[2]!, 10) };
  }
  return { path: ref, line: null };
}

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
          className="bg-blue-500 text-blue-50 px-1 py-0.5 rounded text-xs font-mono break-all"
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

/** Default agent markdown components (no file click handler — links open in new tab). */
const AGENT_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children ?? '').replace(/\n$/, '');
    const isInline = !match && !className;
    if (isInline) {
      return (
        <code
          className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs font-mono break-all"
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
 * Build agent markdown components with file-path link interception.
 * When onFileClick is provided, links that look like file paths call the handler
 * instead of opening a new browser window.
 */
function buildAgentMarkdownComponents(
  onFileClick: (path: string, line?: number | null) => void
): Components {
  return {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className || '');
      const code = String(children ?? '').replace(/\n$/, '');
      const isInline = !match && !className;
      if (isInline) {
        return (
          <code
            className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs font-mono break-all"
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
    a: ({ href, children }) => {
      if (isFilePathHref(href)) {
        const { path, line } = parseFilePathRef(href!);
        return (
          <button
            type="button"
            aria-label={`Open ${path} in file browser`}
            className="text-blue-600 hover:text-blue-800 underline decoration-dotted font-mono text-inherit bg-transparent border-none cursor-pointer px-0.5 py-0.5 inline-flex items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 rounded-sm"
            onClick={(e) => {
              e.preventDefault();
              onFileClick(path, line);
            }}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
          {children}
        </a>
      );
    },
  };
}

/**
 * Renders a single message bubble with markdown support and syntax highlighting.
 * Agent messages are left-aligned, user messages are right-aligned.
 *
 * Wrapped in React.memo to prevent re-renders when parent state changes
 * (e.g., scroll position, input value) don't affect this component's props.
 */
export const MessageBubble = React.memo(function MessageBubble({ text, role, streaming, timestamp, ttsApiUrl, ttsStorageId, onPlayAudio, onFileClick }: MessageBubbleProps) {
  const isUser = role === 'user';
  // When onFileClick is provided for agent messages, build components that intercept file-path links.
  // useMemo ensures stable references — react-markdown won't unmount/remount custom renderers.
  const agentComponents = useMemo(
    () => onFileClick ? buildAgentMarkdownComponents(onFileClick) : AGENT_MARKDOWN_COMPONENTS,
    [onFileClick]
  );
  const components = isUser ? USER_MARKDOWN_COMPONENTS : agentComponents;
  const showActions = !streaming && timestamp != null && timestamp > 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] min-w-0 rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-white border border-gray-200 text-gray-900'
        }`}
      >
        <div className="prose prose-sm max-w-none overflow-x-auto break-words">
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
          <MessageActions
            text={text}
            timestamp={timestamp}
            ttsApiUrl={isUser ? undefined : ttsApiUrl}
            ttsStorageId={isUser ? undefined : ttsStorageId}
            hideTts={isUser}
            variant={isUser ? 'on-dark' : 'default'}
            onPlayAudio={isUser ? undefined : onPlayAudio}
          />
        )}
      </div>
    </div>
  );
});
