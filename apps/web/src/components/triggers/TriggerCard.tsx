import type { TriggerResponse } from '@simple-agent-manager/shared';
import { Card } from '@simple-agent-manager/ui';
import {
  AlertCircle,
  Calendar,
  Clock,
  Github,
  MoreVertical,
  Pause,
  Play,
  Trash2,
  Webhook,
} from 'lucide-react';
import { type FC, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { timeAgo } from '../../lib/time-utils';
import { TriggerCredentialWarning } from './TriggerCredentialWarning';

function formatNextRun(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs < 0) return 'overdue';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  active: { color: 'var(--sam-color-success)', label: 'Active' },
  paused: { color: 'var(--sam-color-warning)', label: 'Paused' },
  disabled: { color: 'var(--sam-color-fg-muted)', label: 'Disabled' },
};

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

function formatTriggerSource(trigger: TriggerResponse): string {
  if (trigger.sourceType === 'github') {
    const eventLabel = trigger.githubConfig?.eventType?.replace(/_/g, ' ') ?? 'event';
    const commandPrefix = trigger.githubConfig?.filters.commandPrefix;
    return commandPrefix ? `GitHub ${eventLabel}: ${commandPrefix}` : `GitHub ${eventLabel}`;
  }
  if (trigger.sourceType === 'webhook') {
    const label = trigger.webhookConfig?.sourceLabel || 'Generic webhook';
    const suffix = trigger.webhookConfig?.tokenLastFour;
    return suffix ? `${label} · token ••••${suffix}` : label;
  }
  return trigger.cronHumanReadable ?? trigger.cronExpression ?? 'No schedule';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TriggerCardProps {
  trigger: TriggerResponse;
  onEdit: (trigger: TriggerResponse) => void;
  onRunNow: (trigger: TriggerResponse) => void;
  onTogglePause: (trigger: TriggerResponse) => void;
  onViewHistory: (trigger: TriggerResponse) => void;
  onDelete?: (trigger: TriggerResponse) => void;
}

export const TriggerCard: FC<TriggerCardProps> = ({
  trigger,
  onEdit,
  onRunNow,
  onTogglePause,
  onViewHistory,
  onDelete,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const statusCfg = STATUS_CONFIG[trigger.status] ?? {
    color: 'var(--sam-color-fg-muted)',
    label: 'Disabled',
  };
  const disabledClass = trigger.status === 'disabled' ? 'opacity-60' : '';

  return (
    <Card
      variant="glass"
      className={`p-4 hover:bg-surface-hover transition-colors duration-150 ${disabledClass}`}
    >
      {/* Header row: name + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: statusCfg.color }}
              aria-label={`Status: ${statusCfg.label}`}
            />
            <h3 className="sam-type-card-title m-0 truncate">{trigger.name}</h3>
          </div>
          {trigger.description && (
            <p className="sam-type-secondary text-fg-muted mt-1 mb-0 line-clamp-2">
              {trigger.description}
            </p>
          )}
        </div>

        {/* Actions menu */}
        <div className="relative shrink-0">
          <button
            ref={menuBtnRef}
            onClick={() => setMenuOpen(!menuOpen)}
            onBlur={() => setTimeout(() => setMenuOpen(false), 200)}
            className={`p-1.5 rounded-sm text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer bg-transparent border-none ${FOCUS_RING}`}
            aria-label="Trigger actions"
            aria-expanded={menuOpen}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen &&
            createPortal(
              <div
                className="w-40 glass-surface rounded-md shadow-lg py-1"
                style={{
                  position: 'fixed',
                  zIndex: 20,
                  ...(menuBtnRef.current
                    ? (() => {
                        const r = menuBtnRef.current!.getBoundingClientRect();
                        return { top: r.bottom + 4, right: window.innerWidth - r.right };
                      })()
                    : {}),
                }}
              >
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit(trigger);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-fg-primary hover:bg-surface-hover cursor-pointer bg-transparent border-none"
                >
                  Edit
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onRunNow(trigger);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-fg-primary hover:bg-surface-hover cursor-pointer bg-transparent border-none"
                  disabled={trigger.status === 'disabled'}
                >
                  Run Now
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onTogglePause(trigger);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-fg-primary hover:bg-surface-hover cursor-pointer bg-transparent border-none"
                >
                  {trigger.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onViewHistory(trigger);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-fg-primary hover:bg-surface-hover cursor-pointer bg-transparent border-none"
                >
                  View History
                </button>
                {onDelete && (
                  <>
                    <div className="border-t border-border-default my-1" />
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onDelete(trigger);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-surface-hover cursor-pointer bg-transparent border-none flex items-center gap-2"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete
                    </button>
                  </>
                )}
              </div>,
              document.body
            )}
        </div>
      </div>

      {/* Schedule info */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-sm text-fg-muted">
        <span className="flex items-center gap-1.5">
          {trigger.sourceType === 'github' ? (
            <Github size={14} aria-hidden="true" />
          ) : trigger.sourceType === 'webhook' ? (
            <Webhook size={14} aria-hidden="true" />
          ) : (
            <Clock size={14} aria-hidden="true" />
          )}
          <span className="truncate max-w-[200px]">{formatTriggerSource(trigger)}</span>
        </span>
        {trigger.sourceType === 'cron' && trigger.nextFireAt && (
          <span className="flex items-center gap-1.5">
            <Calendar size={14} aria-hidden="true" />
            Next: {formatNextRun(trigger.nextFireAt)}
          </span>
        )}
        {trigger.lastTriggeredAt && (
          <span className="flex items-center gap-1.5">
            Last: {timeAgo(trigger.lastTriggeredAt)}
          </span>
        )}
      </div>

      {/* Paused warning */}
      {trigger.status === 'paused' && (
        <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-md bg-warning/10 text-warning text-sm">
          <AlertCircle size={14} aria-hidden="true" />
          <span>Paused — may be due to consecutive failures</span>
        </div>
      )}

      {trigger.credentialAttribution?.multiplayerActive &&
        trigger.credentialAttribution.hasPersonalWarning && (
          <div className="mt-3">
            <TriggerCredentialWarning trigger={trigger} />
          </div>
        )}

      {/* Quick actions row */}
      <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-border-default">
        <button
          onClick={() => onRunNow(trigger)}
          disabled={trigger.status === 'disabled'}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-medium rounded-md bg-transparent border border-border-default text-fg-primary hover:bg-surface-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
          aria-label="Run trigger now"
        >
          <Play size={12} aria-hidden="true" />
          Run Now
        </button>
        <button
          onClick={() => onTogglePause(trigger)}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-medium rounded-md bg-transparent border border-border-default text-fg-primary hover:bg-surface-hover cursor-pointer ${FOCUS_RING}`}
          aria-label={trigger.status === 'paused' ? 'Resume trigger' : 'Pause trigger'}
        >
          <Pause size={12} aria-hidden="true" />
          {trigger.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={() => onViewHistory(trigger)}
          className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-medium rounded-md bg-transparent border border-border-default text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer ml-auto ${FOCUS_RING}`}
        >
          View History
        </button>
      </div>
    </Card>
  );
};
