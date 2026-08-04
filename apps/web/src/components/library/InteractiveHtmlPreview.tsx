import { AlertTriangle, ExternalLink, Play, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';

import { mintInteractivePreviewUrl } from '../../lib/api/library';
import { type FileWithTags, FOCUS_RING } from './types';

interface Props {
  file: FileWithTags;
}

export function InteractiveHtmlPreview({ file }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const result = await mintInteractivePreviewUrl(file.projectId, file.id);
      setPreviewUrl(result.url);
      setFrameKey((value) => value + 1);
      setConfirming(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start interactive preview');
    } finally {
      setLoading(false);
    }
  }

  async function openInNewTab() {
    setError(null);
    try {
      const result = await mintInteractivePreviewUrl(file.projectId, file.id);
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open interactive preview');
    }
  }

  if (!previewUrl) {
    return (
      <section className="border-t border-border-default bg-surface-secondary p-3 sm:p-4">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={`inline-flex items-center gap-2 rounded-md border border-border-default bg-surface-primary px-3 py-2 text-sm font-medium text-fg-primary hover:bg-surface-hover ${FOCUS_RING}`}
          >
            <Play size={15} />
            Run interactive preview
          </button>
        ) : (
          <div
            role="alertdialog"
            aria-labelledby="interactive-preview-title"
            className="max-w-2xl rounded-lg border border-warning-border bg-warning-subtle p-4"
          >
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 shrink-0 text-warning-fg" size={20} />
              <div className="min-w-0">
                <h3 id="interactive-preview-title" className="font-semibold text-fg-primary">
                  Run agent-generated JavaScript?
                </h3>
                <p className="mt-1 text-sm text-fg-secondary">
                  Network access is disabled and SAM credentials are not exposed. Do not enter
                  passwords, API keys, or other secrets.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={start}
                    className={`rounded-md bg-accent-solid px-3 py-2 text-sm font-medium text-white disabled:opacity-50 ${FOCUS_RING}`}
                  >
                    {loading ? 'Starting…' : 'Run preview'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className={`rounded-md border border-border-default px-3 py-2 text-sm text-fg-primary ${FOCUS_RING}`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger-fg">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-border-default">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-warning-subtle px-3 py-2">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-warning-fg">
          <AlertTriangle size={15} className="shrink-0" />
          Agent-generated interactive preview — network disabled
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setPreviewUrl(null)}
            className={`inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs ${FOCUS_RING}`}
          >
            <Square size={12} /> Stop
          </button>
          <button
            type="button"
            onClick={() => setFrameKey((value) => value + 1)}
            className={`inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs ${FOCUS_RING}`}
          >
            <RotateCcw size={12} /> Reset
          </button>
          <button
            type="button"
            onClick={openInNewTab}
            className={`inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs ${FOCUS_RING}`}
          >
            <ExternalLink size={12} /> Open in new tab
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-sm text-danger-fg">
          {error}
        </p>
      )}
      <iframe
        key={frameKey}
        title={`Interactive preview of ${file.filename}`}
        sandbox="allow-scripts"
        src={previewUrl}
        className="min-h-[20rem] w-full flex-1 border-0 bg-white"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
