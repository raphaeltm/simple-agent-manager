import { Alert, Button } from '@simple-agent-manager/ui';
import { ExternalLink, Globe, Loader2, X } from 'lucide-react';
import { type FC, useCallback } from 'react';

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
 * BrowserSidecar provides controls to start/stop a Neko remote browser sidecar
 * and opens it in a new browser tab when running.
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

  const handleStart = useCallback(async () => {
    const opts = {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      isTouchDevice: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    };
    const result = await start(opts);
    // Open in new tab once URL is available
    if (result?.url) {
      window.open(result.url, '_blank', 'noopener,noreferrer');
    }
  }, [start]);

  const handleOpen = useCallback(() => {
    if (status?.url) {
      window.open(status.url, '_blank', 'noopener,noreferrer');
    }
  }, [status?.url]);

  const handleStop = useCallback(async () => {
    await stop();
  }, [stop]);

  const sidecarStatus = status?.status ?? 'off';
  const isRunning = sidecarStatus === 'running';
  const isStarting = sidecarStatus === 'starting';

  return (
    <div data-testid="browser-sidecar">
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
            Start Remote Browser
          </Button>
        )}

        {(isStarting || isRunning) && (
          <>
            <Button
              variant={isRunning ? 'primary' : 'secondary'}
              size="sm"
              onClick={handleOpen}
              disabled={isLoading || !status?.url}
              aria-label="Open remote browser in new tab"
            >
              <ExternalLink size={14} aria-hidden="true" />
              Open Browser
              {isStarting && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {isStarting && <span className="sr-only">Starting browser...</span>}
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={handleStop}
              loading={isLoading}
              aria-label="Stop remote browser"
            >
              <X size={14} aria-hidden="true" />
              Stop
            </Button>
          </>
        )}

        {sidecarStatus === 'error' && (
          <div className="flex flex-col gap-2">
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

      {/* Port forwarders info */}
      {isRunning && status?.ports && status.ports.length > 0 && (
        <div className="text-xs text-fg-muted mt-1">
          Forwarded ports: {status.ports.map((p) => p.port).join(', ')}
        </div>
      )}
    </div>
  );
};
