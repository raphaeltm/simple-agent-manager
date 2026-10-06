import React, { useState } from 'react';

import type { AgentCrashReportItem } from '../hooks/useAcpMessages';

interface AgentCrashReportViewProps {
  item: AgentCrashReportItem;
}

const crashReportTones = {
  recovered: {
    border: 'var(--sam-color-warning, #f59e0b)',
    bg: 'var(--sam-color-warning-tint, rgba(245, 158, 11, 0.1))',
    fg: 'var(--sam-color-warning-fg, #fbbf24)',
    labelBg: 'var(--sam-color-warning-tint, rgba(245, 158, 11, 0.1))',
    label: 'Recovered',
  },
  failed: {
    border: 'var(--sam-color-danger, #ef4444)',
    bg: 'var(--sam-color-danger-tint, rgba(239, 68, 68, 0.1))',
    fg: 'var(--sam-color-danger-fg, #f87171)',
    labelBg: 'var(--sam-color-danger-tint, rgba(239, 68, 68, 0.1))',
    label: 'Recovery failed',
  },
} as const;

export const AgentCrashReportView = React.memo(function AgentCrashReportView({ item }: AgentCrashReportViewProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const tone = item.recovered ? crashReportTones.recovered : crashReportTones.failed;

  const copyDebugInfo = async () => {
    const debugInfo = [
      `Agent: ${item.agentType}`,
      `Recovered: ${item.recovered ? 'yes' : 'no'}`,
      `Timestamp: ${new Date(item.timestamp).toISOString()}`,
      `stderr truncated: ${item.stderrTruncated ? 'yes' : 'no'}`,
      item.message,
      item.attribution,
      item.suggestion,
      item.recoveryError ? `Recovery error: ${item.recoveryError}` : '',
      item.stderr ? `stderr:\n${item.stderr}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable');
      }
      await navigator.clipboard.writeText(debugInfo);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <section
      role="status"
      aria-label={`${item.agentType} crash report`}
      className="my-3 rounded-lg px-4 py-3 shadow-sm"
      style={{
        border: `1px solid color-mix(in srgb, ${tone.border} 40%, transparent)`,
        backgroundColor: tone.bg,
        color: tone.fg,
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{
                backgroundColor: tone.labelBg,
                border: `1px solid color-mix(in srgb, ${tone.border} 40%, transparent)`,
                color: tone.fg,
              }}
            >
              {tone.label}
            </span>
            <span className="text-xs font-medium uppercase opacity-70">
              Agent crash
            </span>
          </div>
          <p className="m-0 text-sm font-semibold leading-5" style={{ color: 'var(--sam-color-fg-primary, inherit)' }}>
            {item.message}
          </p>
          <p className="m-0 mt-1 text-sm leading-5" style={{ color: 'var(--sam-color-fg-secondary, inherit)' }}>
            {item.attribution}
          </p>
          <p className="m-0 mt-1 text-sm leading-5" style={{ color: 'var(--sam-color-fg-secondary, inherit)' }}>
            {item.suggestion}
          </p>
          {item.recoveryError && (
            <p className="m-0 mt-2 text-xs font-mono leading-5 break-words" style={{ color: tone.fg }}>
              Recovery error: {item.recoveryError}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copyDebugInfo()}
          aria-live="polite"
          className="min-h-11 shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer"
          style={{
            backgroundColor: tone.bg,
            border: `1px solid color-mix(in srgb, ${tone.border} 40%, transparent)`,
            color: tone.fg,
          }}
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy report'}
        </button>
      </div>
      {item.stderr && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium" style={{ color: tone.fg }}>
            stderr debugging output
          </summary>
          {item.stderrTruncated && (
            <p className="m-0 mt-2 text-xs" style={{ color: 'var(--sam-color-fg-muted, inherit)' }}>
              stderr was truncated to the latest captured buffer.
            </p>
          )}
          <pre
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-5"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas, #1a1a1a) 80%, transparent)',
              color: 'var(--sam-color-fg-secondary, #d1d5db)',
              border: '1px solid var(--sam-form-border, rgba(255,255,255,0.1))',
            }}
          >
            {item.stderr}
          </pre>
        </details>
      )}
    </section>
  );
});
