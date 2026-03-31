import { type FC, useState, useCallback, useEffect } from 'react';
import { Globe, Loader2, X, Monitor, AlertCircle } from 'lucide-react';
import { useBrowserSidecar } from '../hooks/useBrowserSidecar';

interface BrowserSidecarSessionProps {
  projectId: string;
  sessionId: string;
  workspaceId?: never;
}

interface BrowserSidecarWorkspaceProps {
  workspaceId: string;
  projectId?: never;
  sessionId?: never;
}

type BrowserSidecarProps = BrowserSidecarSessionProps | BrowserSidecarWorkspaceProps;

/**
 * BrowserSidecar provides a button to start/stop a Neko remote browser sidecar
 * and an iframe to view the browser stream when running.
 *
 * Supports two modes:
 * - Session mode: requires projectId + sessionId (used in project chat)
 * - Workspace mode: requires workspaceId only (used in workspace sidebar)
 */
export const BrowserSidecar: FC<BrowserSidecarProps> = (props) => {
  const hookOptions = 'workspaceId' in props && props.workspaceId
    ? { workspaceId: props.workspaceId }
    : { projectId: props.projectId!, sessionId: props.sessionId! };

  const { status, isLoading, error, start, stop } = useBrowserSidecar(hookOptions);
  const [showViewer, setShowViewer] = useState(false);

  const handleStart = useCallback(async () => {
    // Detect viewport for mobile emulation
    const opts = {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      isTouchDevice: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    };
    await start(opts);
    setShowViewer(true);
  }, [start]);

  const handleStop = useCallback(async () => {
    setShowViewer(false);
    await stop();
  }, [stop]);

  const sidecarStatus = status?.status ?? 'off';
  const isRunning = sidecarStatus === 'running';
  const isStarting = sidecarStatus === 'starting';

  // Reset viewer when sidecar transitions to off or error
  useEffect(() => {
    if (sidecarStatus === 'off' || sidecarStatus === 'error') {
      setShowViewer(false);
    }
  }, [sidecarStatus]);

  return (
    <div className="browser-sidecar">
      {/* Control button */}
      <div className="browser-sidecar-controls" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        {sidecarStatus === 'off' && (
          <button
            onClick={handleStart}
            disabled={isLoading}
            className="browser-sidecar-btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid var(--sam-border, #e2e8f0)',
              background: 'var(--sam-bg-secondary, #f8fafc)',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontSize: '13px',
            }}
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
            Remote Browser
          </button>
        )}

        {(isStarting || isRunning) && (
          <>
            <button
              onClick={() => setShowViewer(!showViewer)}
              className="browser-sidecar-btn"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid var(--sam-border, #e2e8f0)',
                background: isRunning ? 'var(--sam-bg-accent, #eff6ff)' : 'var(--sam-bg-secondary, #f8fafc)',
                cursor: 'pointer',
                fontSize: '13px',
              }}
            >
              <Monitor size={14} />
              {showViewer ? 'Hide' : 'Show'} Browser
              {isStarting && <Loader2 size={12} className="animate-spin" />}
            </button>
            <button
              onClick={handleStop}
              disabled={isLoading}
              className="browser-sidecar-btn"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--sam-border-danger, #fecaca)',
                background: 'var(--sam-bg-danger, #fef2f2)',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                fontSize: '13px',
                color: 'var(--sam-text-danger, #dc2626)',
              }}
              title="Stop remote browser"
              aria-label="Stop remote browser"
            >
              <X size={14} />
            </button>
          </>
        )}

        {sidecarStatus === 'error' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--sam-text-danger, #dc2626)', fontSize: '13px' }}>
            <AlertCircle size={14} />
            <span>{status?.error ?? 'Browser sidecar error'}</span>
            <button
              onClick={handleStart}
              style={{
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid var(--sam-border, #e2e8f0)',
                background: 'var(--sam-bg-secondary, #f8fafc)',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--sam-text-danger, #dc2626)', fontSize: '12px', marginBottom: '8px' }}>
          {error}
        </div>
      )}

      {/* Neko viewer iframe */}
      {showViewer && isRunning && status?.url && (
        <div
          className="browser-sidecar-viewer"
          style={{
            border: '1px solid var(--sam-border, #e2e8f0)',
            borderRadius: '8px',
            overflow: 'hidden',
            position: 'relative',
            width: '100%',
            aspectRatio: '16/9',
          }}
        >
          <iframe
            src={status.url}
            title="Remote Browser"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
            }}
            allow="autoplay; clipboard-write; clipboard-read"
            sandbox="allow-scripts allow-forms allow-popups"
          />
        </div>
      )}

      {/* Port forwarders info */}
      {isRunning && status?.ports && status.ports.length > 0 && (
        <div style={{ fontSize: '12px', color: 'var(--sam-text-secondary, #64748b)', marginTop: '4px' }}>
          Forwarded ports: {status.ports.map((p) => p.port).join(', ')}
        </div>
      )}
    </div>
  );
};
