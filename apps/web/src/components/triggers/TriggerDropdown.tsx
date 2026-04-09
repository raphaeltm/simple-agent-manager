/**
 * TriggerDropdown — lightweight popover showing active triggers for a project.
 *
 * Displayed from the project chat sidebar header (Clock icon).
 * Fetches trigger list on open (not on page load) to stay lightweight.
 */
import type { TriggerResponse } from '@simple-agent-manager/shared';
import { AlertTriangle, Clock, Plus } from 'lucide-react';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { listTriggers } from '../../lib/api/triggers';

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
  const [triggers, setTriggers] = useState<TriggerResponse[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTriggers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listTriggers(projectId);
      setTriggers(result.triggers);
    } catch (err) {
      console.error('Failed to fetch triggers:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Fetch triggers when dropdown opens
  useEffect(() => {
    if (open) {
      void fetchTriggers();
    }
  }, [open, fetchTriggers]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onToggle();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onToggle]);

  const activeTriggers = triggers.filter((t) => t.status === 'active');
  const pausedTriggers = triggers.filter((t) => t.status === 'paused');

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={onToggle}
        title="Automation triggers"
        aria-label="Automation triggers"
        aria-expanded={open}
        className="shrink-0 p-1 bg-transparent border-none cursor-pointer text-fg-muted rounded-sm hover:text-fg-primary transition-colors"
      >
        <Clock size={15} />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-72 rounded-lg border border-border-default bg-surface shadow-lg z-50 overflow-hidden"
          role="menu"
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
                    role="menuitem"
                    onClick={() => {
                      onToggle();
                      navigate(`/projects/${projectId}/triggers/${trigger.id}`);
                    }}
                    className="flex items-start gap-2 w-full px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-surface-hover transition-colors"
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
                    role="menuitem"
                    onClick={() => {
                      onToggle();
                      navigate(`/projects/${projectId}/triggers/${trigger.id}`);
                    }}
                    className="flex items-start gap-2 w-full px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-surface-hover transition-colors opacity-60"
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
              role="menuitem"
              onClick={() => {
                onToggle();
                navigate(`/projects/${projectId}/triggers`);
              }}
              className="flex-1 flex items-center gap-1.5 text-xs text-accent-primary bg-transparent border-none cursor-pointer py-1 hover:underline"
            >
              <Plus size={12} />
              New Trigger
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onToggle();
                navigate(`/projects/${projectId}/triggers`);
              }}
              className="text-xs text-fg-muted bg-transparent border-none cursor-pointer py-1 hover:text-fg-primary hover:underline"
            >
              Manage
            </button>
          </div>
        </div>
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
