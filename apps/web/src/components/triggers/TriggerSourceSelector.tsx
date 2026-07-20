import type { TriggerSourceType } from '@simple-agent-manager/shared';
import { Clock, Github, Webhook } from 'lucide-react';

import { FOCUS_RING } from './trigger-form-support';

interface TriggerSourceSelectorProps {
  value: TriggerSourceType;
  disabled: boolean;
  onChange: (value: TriggerSourceType) => void;
}

const SOURCES = [
  { value: 'cron' as const, label: 'Schedule', description: 'Run on a cron schedule', icon: Clock },
  {
    value: 'github' as const,
    label: 'GitHub event',
    description: 'Run when repository events match',
    icon: Github,
  },
  {
    value: 'webhook' as const,
    label: 'Webhook',
    description: 'Run from authenticated JSON',
    icon: Webhook,
  },
];

export function TriggerSourceSelector({ value, disabled, onChange }: TriggerSourceSelectorProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-fg-primary mb-2">Source</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {SOURCES.map((source) => {
          const Icon = source.icon;
          return (
            <button
              key={source.value}
              type="button"
              onClick={() => onChange(source.value)}
              disabled={disabled}
              className={`flex items-center gap-3 rounded-md border px-3 py-3 text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${
                value === source.value
                  ? 'border-accent bg-accent/10 text-fg-primary'
                  : 'border-border-default bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
              } ${FOCUS_RING}`}
              aria-pressed={value === source.value}
            >
              <Icon size={18} aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium">{source.label}</span>
                <span className="block text-xs">{source.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
