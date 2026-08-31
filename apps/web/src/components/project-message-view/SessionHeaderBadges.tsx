import type { DetectedPort, WorkspaceResponse } from '@simple-agent-manager/shared';
import { AlertTriangle, ExternalLink, Globe } from 'lucide-react';
import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function getWorkspaceProfileLabel(workspace: WorkspaceResponse): string {
  if (workspace.status === 'recovery') return 'Recovery container';
  return workspace.workspaceProfile === 'lightweight' ? 'Lightweight' : 'Full';
}

const RECOVERY_CONTAINER_HELP = 'The devcontainer build failed, so SAM started a fallback recovery container to keep this chat usable. Open the workspace and check Boot Logs for the devcontainer error output.';

export function WorkspaceProfileBadge({ workspace }: Readonly<{ workspace: WorkspaceResponse }>) {
  const [open, setOpen] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const isRecovery = workspace.status === 'recovery';
  const label = getWorkspaceProfileLabel(workspace);
  const badgeClassName = 'inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0';

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const tooltipWidth = Math.min(280, window.innerWidth - 32);
      const left = Math.max(16, Math.min(rect.right - tooltipWidth, window.innerWidth - tooltipWidth - 16));
      setTooltipStyle({
        position: 'fixed',
        left,
        top: rect.bottom + 4,
        width: tooltipWidth,
        zIndex: 'var(--sam-z-dropdown)' as unknown as number,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  if (!isRecovery) {
    return (
      <span
        className={badgeClassName}
        aria-label={`Workspace profile: ${label}`}
        style={{
          backgroundColor: workspace.workspaceProfile === 'lightweight' ? 'var(--sam-color-info-tint)' : 'var(--sam-color-success-tint)',
          color: workspace.workspaceProfile === 'lightweight' ? 'var(--sam-color-info)' : 'var(--sam-color-success)',
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Recovery container: devcontainer build failed"
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className={`${badgeClassName} border border-transparent cursor-help focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary`}
        style={{
          backgroundColor: 'var(--sam-color-warning-tint, rgba(245, 158, 11, 0.12))',
          color: 'var(--sam-color-warning, #f59e0b)',
          borderColor: 'color-mix(in srgb, var(--sam-color-warning, #f59e0b) 24%, transparent)',
        }}
      >
        <AlertTriangle size={10} aria-hidden="true" />
        {label}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className="rounded-sm glass-surface bg-[var(--sam-tooltip-bg)] px-3 py-2 text-left text-fg-primary shadow-tooltip whitespace-normal pointer-events-none"
          style={{
            fontSize: 'var(--sam-type-caption-size)',
            lineHeight: 'var(--sam-type-caption-line-height)',
            ...tooltipStyle,
          }}
        >
          {RECOVERY_CONTAINER_HELP}
        </span>,
        document.body,
      )}
    </span>
  );
}

export function PortsContextItem({
  ports,
  getHref,
}: {
  ports: DetectedPort[];
  getHref: (port: DetectedPort) => string;
}) {
  return (
    <div className="flex items-start gap-1.5 text-xs text-fg-muted min-w-0">
      <Globe size={12} className="shrink-0 opacity-60 mt-0.5" aria-hidden="true" />
      <span className="font-medium shrink-0">Ports ({ports.length}):</span>
      <span className="text-fg-primary inline-flex flex-wrap gap-1.5 min-w-0">
        {ports
          .slice()
          .sort((a, b) => a.port - b.port)
          .map((p) => (
            <a
              key={p.port}
              href={getHref(p)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[11px] no-underline hover:underline"
              style={{ color: 'var(--sam-color-accent-primary)' }}
              title={p.label}
            >
              {p.port}
              {p.address === '127.0.0.1' || p.address === '::1' ? ' (local)' : ''}
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          ))}
      </span>
    </div>
  );
}
