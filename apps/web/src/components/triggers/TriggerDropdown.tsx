/**
 * TriggerDropdown — lightweight popover showing active triggers for a project.
 *
 * Displayed from the project chat sidebar header (Clock icon).
 * Fetches trigger list on open (not on page load) to stay lightweight.
 */
import type { TriggerResponse } from '@simple-agent-manager/shared';
import { AlertTriangle, Clock, Plus } from 'lucide-react';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { listTriggers } from '../../lib/api/triggers';

const POPOVER_WIDTH = 288;
const POPOVER_MARGIN = 8;
const POPOVER_OFFSET = 4;
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

interface TriggerDropdownProps {
  projectId: string;
  /** Whether the dropdown is currently visible. */
  open: boolean;
  /** Callback to toggle the dropdown. */
  onToggle: () => void;
}

export const TriggerDropdown: FC<TriggerDropdownProps> = ({ projectId, open, onToggle }) => {
  const navigate = useNavigate();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const [triggers, setTriggers] = useState<TriggerResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: POPOVER_MARGIN,
    left: POPOVER_MARGIN,
  });

  const updatePosition = useCallback(() => {
    const triggerButton = triggerBtnRef.current;
    if (!triggerButton) return;
    const rect = triggerButton.getBoundingClientRect();
    const maxLeft = Math.max(POPOVER_MARGIN, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN);
    setPosition({
      top: Math.max(POPOVER_MARGIN, rect.bottom + POPOVER_OFFSET),
      left: Math.min(Math.max(POPOVER_MARGIN, rect.left), maxLeft),
    });
  }, []);

  const closePopover = useCallback(() => {
    if (!open) return;
    onToggle();
    requestAnimationFrame(() => triggerBtnRef.current?.focus());
  }, [open, onToggle]);

  const fetchTriggers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listTriggers(projectId);
      setTriggers(result.triggers);
    } catch (err) {
      setTriggers([]);
      setLoadError(err instanceof Error ? err.message : 'Failed to load triggers');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Fetch triggers when dropdown opens
  useEffect(() => {
    if (open) {
      updatePosition();
      void fetchTriggers();
    }
  }, [open, fetchTriggers, updatePosition]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const insideTrigger = dropdownRef.current?.contains(target);
      const insideContent = contentRef.current?.contains(target);
      if (!insideTrigger && !insideContent) {
        closePopover();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopover();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closePopover]);

  const navigateAndClose = useCallback((path: string) => {
    closePopover();
    navigate(path);
  }, [closePopover, navigate]);

  const activeTriggers = triggers.filter((t) => t.status === 'active');
  const pausedTriggers = triggers.filter((t) => t.status === 'paused');
  const popoverId = `trigger-dropdown-${projectId}`;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        ref={triggerBtnRef}
        type="button"
        onClick={onToggle}
        title="Automation triggers"
        aria-label="Automation triggers"
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        className={`shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors ${FOCUS_RING}`}
      >
        <Clock size={15} aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          id={popoverId}
          ref={contentRef}
          className="w-72 max-w-[calc(100vw-16px)] rounded-lg glass-surface shadow-lg overflow-hidden"
          style={{
            position: 'fixed',
            zIndex: 50,
            top: position.top,
            left: position.left,
          }}
          role="dialog"
          aria-modal="false"
          aria-label="Automation triggers"
        >
          {/* Header */}
          <div className="px-3 py-2 border-b border-border-default">
            <h4 className="text-xs font-semibold text-fg-primary m-0 uppercase tracking-wider">
              Triggers
            </h4>
          </div>

          {/* Content */}
          <div className="max-h-64 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-4 text-center text-xs text-fg-muted">
                Loading...
              </div>
            ) : loadError ? (
              <div className="px-3 py-4 text-center">
                <div className="text-xs text-danger mb-3" role="alert">
                  {loadError}
                </div>
                <button
                  type="button"
                  onClick={() => void fetchTriggers()}
                  className={`text-xs text-accent-primary bg-transparent border border-border-default rounded-md px-3 py-1.5 cursor-pointer hover:bg-surface-hover ${FOCUS_RING}`}
                >
                  Retry
                </button>
              </div>
            ) : triggers.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-fg-muted">
                No triggers configured.
              </div>
            ) : (
              <>
                {activeTriggers.map((trigger) => (
                  <button
                    key={trigger.id}
                    type="button"
                    onClick={() => navigateAndClose(`/projects/${projectId}/triggers/${trigger.id}`)}
                    className={`flex items-start gap-2 w-full px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-surface-hover transition-colors ${FOCUS_RING}`}
                  >
                    <Clock size={12} className="text-fg-muted shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-fg-primary truncate">
                        {trigger.name}
                      </div>
                      {trigger.nextFireAt && (
                        <div className="text-[10px] text-fg-muted">
                          Next: {formatRelativeTime(trigger.nextFireAt)}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
                {pausedTriggers.map((trigger) => (
                  <button
                    key={trigger.id}
                    type="button"
                    onClick={() => navigateAndClose(`/projects/${projectId}/triggers/${trigger.id}`)}
                    className={`flex items-start gap-2 w-full px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-surface-hover transition-colors opacity-60 ${FOCUS_RING}`}
                  >
                    <AlertTriangle size={12} className="text-fg-muted shrink-0 mt-0.5" style={{ color: 'var(--sam-color-warning)' }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-fg-muted truncate">
                        {trigger.name}
                      </div>
                      <div className="text-[10px] text-fg-muted">Paused</div>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border-default px-3 py-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigateAndClose(`/projects/${projectId}/triggers`)}
              className={`flex-1 flex items-center gap-1.5 text-xs text-accent-primary bg-transparent border-none cursor-pointer py-1 hover:underline ${FOCUS_RING}`}
            >
              <Plus size={12} aria-hidden="true" />
              New Trigger
            </button>
            <button
              type="button"
              onClick={() => navigateAndClose(`/projects/${projectId}/triggers`)}
              className={`text-xs text-fg-muted bg-transparent border-none cursor-pointer py-1 hover:text-fg-primary hover:underline ${FOCUS_RING}`}
            >
              Manage
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

/** Format an ISO date as a relative time string. */
function formatRelativeTime(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now();
  const absDiff = Math.abs(diff);
  const minutes = Math.floor(absDiff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (diff < 0) {
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  if (minutes < 1) return 'in < 1m';
  if (minutes < 60) return `in ${minutes}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${days}d`;
}
