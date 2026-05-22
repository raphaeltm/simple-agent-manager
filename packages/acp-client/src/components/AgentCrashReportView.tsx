import React, { useState } from 'react';

import type { AgentCrashReportItem } from '../hooks/useAcpMessages';

interface AgentCrashReportViewProps {
  item: AgentCrashReportItem;
}

export const AgentCrashReportView = React.memo(function AgentCrashReportView({ item }: AgentCrashReportViewProps) {
  const [copied, setCopied] = useState(false);
  const tone = item.recovered ? 'amber' : 'red';
  const containerClass = tone === 'amber'
    ? 'border-amber-300 bg-amber-50 text-amber-950'
    : 'border-red-300 bg-red-50 text-red-950';
  const labelClass = tone === 'amber'
    ? 'bg-amber-100 text-amber-800 border-amber-200'
    : 'bg-red-100 text-red-800 border-red-200';
  const buttonClass = tone === 'amber'
    ? 'border-amber-300 bg-white text-amber-900 hover:bg-amber-100'
    : 'border-red-300 bg-white text-red-900 hover:bg-red-100';

  const copyDebugInfo = async () => {
    const debugInfo = [
      item.message,
      item.attribution,
      item.recoveryError ? `Recovery error: ${item.recoveryError}` : '',
      item.stderr ? `stderr:\n${item.stderr}` : '',
    ].filter(Boolean).join('\n\n');
    await navigator.clipboard.writeText(debugInfo);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section
      role="status"
      aria-label={`${item.agentType} crash report`}
      className={`my-3 rounded-lg border px-4 py-3 shadow-sm ${containerClass}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${labelClass}`}>
              {item.recovered ? 'Recovered' : 'Recovery failed'}
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
          className={`min-h-11 shrink-0 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${buttonClass}`}
        >
          {copied ? 'Copied' : 'Copy report'}
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
