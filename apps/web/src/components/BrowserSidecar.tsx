import { type FC, useState, useCallback, useEffect } from 'react';
import { Globe, Loader2, X, Monitor } from 'lucide-react';
import { Button, Alert } from '@simple-agent-manager/ui';
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
      {/* Control buttons */}
      <div className="flex items-center gap-2 mb-2">
        {sidecarStatus === 'off' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleStart}
            loading={isLoading}
            aria-label="Start remote browser"
          >
            <Globe size={14} aria-hidden="true" />
            Remote Browser
          </Button>
        )}

        {(isStarting || isRunning) && (
          <>
            <Button
              variant={isRunning ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setShowViewer(!showViewer)}
              aria-label={showViewer ? 'Hide remote browser' : 'Show remote browser'}
            >
              <Monitor size={14} aria-hidden="true" />
              {showViewer ? 'Hide' : 'Show'} Browser
              {isStarting && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {isStarting && <span className="sr-only">Starting browser...</span>}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleStop}
              loading={isLoading}
              aria-label="Stop remote browser"
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </>
        )}

        {sidecarStatus === 'error' && (
          <div className="flex items-center gap-2">
            <Alert variant="error">
              {status?.error ?? 'Browser sidecar error'}
            </Alert>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleStart}
              aria-label="Retry starting remote browser"
            >
              Retry
            </Button>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="error" className="mb-2">
          {error}
        </Alert>
      )}

      {/* Neko viewer iframe */}
      {showViewer && isRunning && status?.url && (
        <div className="border border-border-default rounded-lg overflow-hidden relative w-full" style={{ aspectRatio: '16/9' }}>
          <iframe
            src={status.url}
            title="Remote Browser"
            className="w-full h-full border-none"
            allow="autoplay; clipboard-write; clipboard-read"
            sandbox="allow-scripts allow-forms allow-popups"
          />
        </div>
      )}

      {/* Port forwarders info */}
      {isRunning && status?.ports && status.ports.length > 0 && (
        <div className="text-xs text-fg-secondary mt-1">
          Forwarded ports: {status.ports.map((p) => p.port).join(', ')}
        </div>
      )}
    </div>
  );
};
