/**
 * SAM-themed markdown renderer for the top-level agent chat.
 * Uses react-markdown + prism-react-renderer with green glass styling.
 */
import './sam-markdown.css';

import { Check, Copy } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import React, { useCallback, useState } from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Stable remark plugins array
const REMARK_PLUGINS = [remarkGfm];

/** execCommand('copy') fallback for non-HTTPS or permission-denied contexts. */
function execCommandCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Copy-to-clipboard button for code blocks. */
function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const onSuccess = useCallback(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  const handleCopy = useCallback(() => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(onSuccess).catch(() => {
        if (execCommandCopy(code)) onSuccess();
      });
    } else {
      if (execCommandCopy(code)) onSuccess();
    }
  }, [code, onSuccess]);

  return (
    <button
      type="button"
      className="sam-copy-btn"
      onClick={handleCopy}
      aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
    >
      {copied ? (
        <span className="inline-flex items-center gap-1">
          <Check className="w-3 h-3" aria-hidden="true" /> Copied
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <Copy className="w-3 h-3" aria-hidden="true" /> Copy
        </span>
      )}
    </button>
  );
}

/** Syntax-highlighted code block with green glass frame. */
function SamCodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="sam-code-block" role="group" aria-label={`${language || 'text'} code block`}>
      <div className="sam-code-header">
        <span className="sam-code-lang">{language || 'text'}</span>
        <CopyButton code={code} />
      </div>
      <Highlight theme={themes.nightOwl} code={code} language={language || 'text'}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre
            style={{
              margin: 0,
              background: 'rgba(0, 0, 0, 0.35)',
              overflow: 'auto',
              padding: '14px',
              fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
              fontSize: '0.82rem',
              lineHeight: '1.55',
              tabSize: 2,
            }}
          >
            {tokens.map((line, lineIdx) => {
              const lineProps = getLineProps({ line });
              return (
                <div
                  key={lineIdx}
                  {...lineProps}
                  style={{ ...lineProps.style, display: 'flex', padding: 0, whiteSpace: 'pre', minHeight: '1.55em' }}
                >
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
    </div>
  );
}

/** SAM-themed markdown component overrides. */
const SAM_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children ?? '').replace(/\n$/, '');
    const isInline = !match && !className;
    if (isInline) {
      return (
        <code
          style={{
            background: 'rgba(60, 180, 120, 0.1)',
            border: '1px solid rgba(60, 180, 120, 0.2)',
            borderRadius: '4px',
            padding: '1px 6px',
            fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontSize: '0.84em',
            color: 'rgba(100, 220, 160, 0.9)',
          }}
          {...props}
        >
          {children}
        </code>
      );
    }
    return <SamCodeBlock code={code} language={match?.[1] ?? ''} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  ),
};

interface SamMarkdownProps {
  content: string;
}

/**
 * Renders markdown content with the SAM green glass theme.
 * Used inside SAM message bubbles in the top-level conversation UI.
 */
export const SamMarkdown = React.memo(function SamMarkdown({ content }: SamMarkdownProps) {
  return (
    <div className="sam-markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={SAM_MARKDOWN_COMPONENTS}>
        {content}
      </Markdown>
    </div>
  );
});
