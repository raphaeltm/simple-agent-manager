import { AlertTriangle, ExternalLink, Play, RotateCcw, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { mintInteractivePreviewUrl } from '../../lib/api/library';
import { type FileWithTags, FOCUS_RING } from './types';

interface Props {
  file: FileWithTags;
}

const CONTROL_CLASS =
  'inline-flex items-center gap-1 rounded border border-border-default px-2 py-1 text-xs text-fg-primary hover:bg-surface-hover';

/**
 * Runs an agent-generated HTML artifact in the isolated preview origin.
 *
 * The preview starts automatically when the artifact is opened: reaching this component already
 * required a deliberate user action (opening the file), so a second in-modal confirmation was pure
 * friction. JS still never executes passively in a chat timeline — `DocumentCard` only mounts the
 * preview modal on click.
 *
 * Isolation is unchanged and lives entirely outside this component: a signed short-lived URL on
 * `preview.<domain>`, served with `CSP: sandbox allow-scripts; default-src 'none'; connect-src 'none'`,
 * giving the document an opaque origin with no cookies, no storage, and no network egress.
 */
export function InteractiveHtmlPreview({ file }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinguishes "the user pressed Stop" from "nothing has loaded yet". Without this the auto-run
  // effect would immediately undo a Stop click (see .claude/rules/06 interaction-effect analysis).
  const [stopped, setStopped] = useState(false);

  // Guards against overlapping mints. `DocumentCard` builds its `file` prop as a fresh object
  // literal on every render, so this component re-renders often; the effect below keys on primitives
  // only, and this ref stops a second mint from racing an in-flight one.
  const mintingRef = useRef(false);

  const { projectId, id: fileId } = file;

  const run = useCallback(async () => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    // Clear `stopped` BEFORE awaiting, not after. Every path into run() (mount, Reset, Run again)
    // is starting a preview, so leaving it set would keep "Preview stopped." and the "Run again"
    // button on screen for the whole mint round-trip, then snap to the iframe with no feedback.
    setStopped(false);
    setLoading(true);
    setError(null);
    try {
      const result = await mintInteractivePreviewUrl(projectId, fileId);
      setPreviewUrl(result.url);
      setFrameKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start interactive preview');
    } finally {
      mintingRef.current = false;
      setLoading(false);
    }
  }, [projectId, fileId]);

  // Auto-run on open. Depends on the identifying primitives — never on the `file` object, whose
  // identity changes on every render at the DocumentCard call site and would cause a mint loop.
  //
  // Dropping the previous URL here (and only here) is what keeps a swapped-in artifact from
  // rendering the PREVIOUS artifact's content under the new artifact's title while its mint is in
  // flight. This effect fires only on mount and on a genuine projectId/fileId change; Reset and
  // Run again call run() directly, so they keep the current frame mounted while re-minting.
  useEffect(() => {
    setPreviewUrl(null);
    void run();
  }, [run]);

  function stop() {
    setStopped(true);
    setPreviewUrl(null);
    setError(null);
  }

  /**
   * Re-mints rather than reloading the current URL. Signed URLs expire after
   * PREVIEW_URL_TTL_SECONDS (300s by default), so reloading a stale `src` would render the
   * "Preview link expired" error page instead of the artifact.
   */
  function reload() {
    void run();
  }

  async function openInNewTab() {
    setError(null);
    try {
      const result = await mintInteractivePreviewUrl(projectId, fileId);
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open interactive preview');
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Single compact chrome row. Labels collapse to icons below `sm` so the warning and the
          controls share one line — every pixel spent here is taken from the artifact. */}
      <div className="flex shrink-0 items-center justify-between gap-2 bg-warning-surface px-3 py-1.5">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-warning-fg">
          <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
          {/* The negation leads so that right-truncation at narrow widths can never invert the
              meaning: "…no netw" still reads as negated, whereas "network …" reads as enabled. */}
          <span className="truncate">Agent-generated · no network</span>
        </p>
        <div className="flex shrink-0 gap-1">
          {stopped ? (
            <button
              type="button"
              onClick={reload}
              aria-label="Run again"
              className={`${CONTROL_CLASS} ${FOCUS_RING}`}
            >
              <Play size={12} aria-hidden="true" />
              <span className="hidden sm:inline">Run again</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop"
              className={`${CONTROL_CLASS} ${FOCUS_RING}`}
            >
              <Square size={12} aria-hidden="true" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
          <button
            type="button"
            onClick={reload}
            aria-label="Reset"
            className={`${CONTROL_CLASS} ${FOCUS_RING}`}
          >
            <RotateCcw size={12} aria-hidden="true" />
            <span className="hidden sm:inline">Reset</span>
          </button>
          <button
            type="button"
            onClick={openInNewTab}
            aria-label="Open in new tab"
            className={`${CONTROL_CLASS} ${FOCUS_RING}`}
          >
            <ExternalLink size={12} aria-hidden="true" />
            <span className="hidden sm:inline">Open in new tab</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 px-3 py-2">
          <p role="alert" className="text-sm text-danger-fg">
            {error}
          </p>
          <button type="button" onClick={reload} className={`mt-2 ${CONTROL_CLASS} ${FOCUS_RING}`}>
            <RotateCcw size={12} aria-hidden="true" /> Try again
          </button>
        </div>
      )}

      {previewUrl ? (
        <iframe
          key={frameKey}
          title={`Interactive preview of ${file.filename}`}
          sandbox="allow-scripts"
          src={previewUrl}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          {stopped ? (
            <p className="text-sm text-fg-muted">Preview stopped.</p>
          ) : loading ? (
            <p className="text-sm text-fg-muted">Starting interactive preview…</p>
          ) : error ? null : (
            <p className="text-sm text-fg-muted">Preview unavailable.</p>
          )}
        </div>
      )}
    </section>
  );
}
