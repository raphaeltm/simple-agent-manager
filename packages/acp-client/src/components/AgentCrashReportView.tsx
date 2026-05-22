import React, { useState } from 'react';

import type { AgentCrashReportItem } from '../hooks/useAcpMessages';

interface AgentCrashReportViewProps {
  item: AgentCrashReportItem;
}

const crashReportTones = {
  recovered: {
    containerClass: 'border-amber-300 bg-amber-50 text-amber-950',
    labelStyle: { backgroundColor: '#fef3c7', borderColor: '#fbbf24', color: '#92400e' },
    buttonStyle: { backgroundColor: '#fffbeb', borderColor: '#f59e0b', color: '#78350f' },
    label: 'Recovered',
  },
  failed: {
    containerClass: 'border-red-300 bg-red-50 text-red-950',
    labelStyle: { backgroundColor: '#fee2e2', borderColor: '#fca5a5', color: '#991b1b' },
    buttonStyle: { backgroundColor: '#fef2f2', borderColor: '#ef4444', color: '#7f1d1d' },
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
      className={`my-3 rounded-lg border px-4 py-3 shadow-sm ${tone.containerClass}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold"
              style={tone.labelStyle}
            >
              {tone.label}
            </span>
            <span className="text-xs font-medium uppercase text-current opacity-70">
              Agent crash
            </span>
          </div>
          <p className="m-0 text-sm font-semibold leading-5">{item.message}</p>
          <p className="m-0 mt-1 text-sm leading-5">{item.attribution}</p>
          <p className="m-0 mt-1 text-sm leading-5">{item.suggestion}</p>
          {item.recoveryError && (
            <p className="m-0 mt-2 text-xs font-mono leading-5 break-words">
              Recovery error: {item.recoveryError}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copyDebugInfo()}
          aria-live="polite"
          className="min-h-11 shrink-0 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:brightness-95"
          style={tone.buttonStyle}
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy report'}
        </button>
      </div>
      {item.stderr && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">stderr debugging output</summary>
          {item.stderrTruncated && (
            <p className="m-0 mt-2 text-xs">stderr was truncated to the latest captured buffer.</p>
          )}
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-black/10 bg-white/75 p-3 text-xs leading-5 text-slate-900">
            {item.stderr}
          </pre>
        </details>
      )}
    </section>
  );
});
