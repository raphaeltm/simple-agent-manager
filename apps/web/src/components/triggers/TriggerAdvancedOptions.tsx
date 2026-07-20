import {
  type AgentProfile,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
} from '@simple-agent-manager/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { FOCUS_RING, VM_SIZES } from './trigger-form-support';
import { TriggerProfileSelect } from './TriggerProfileSelect';

interface TriggerAdvancedOptionsProps {
  agentProfileId: string;
  maxConcurrent: number;
  onAgentProfileChange: (value: string) => void;
  onMaxConcurrentChange: (value: number) => void;
  onOpenChange: (value: boolean) => void;
  onSkipIfRunningChange: (value: boolean) => void;
  onTaskModeChange: (value: 'task' | 'conversation') => void;
  onVmSizeChange: (value: string) => void;
  open: boolean;
  profiles: AgentProfile[];
  skipIfRunning: boolean;
  sourceType: 'cron' | 'github' | 'webhook';
  taskMode: 'task' | 'conversation';
  vmSize: string;
}

export function TriggerAdvancedOptions({
  agentProfileId,
  maxConcurrent,
  onAgentProfileChange,
  onMaxConcurrentChange,
  onOpenChange,
  onSkipIfRunningChange,
  onTaskModeChange,
  onVmSizeChange,
  open,
  profiles,
  skipIfRunning,
  sourceType,
  taskMode,
  vmSize,
}: TriggerAdvancedOptionsProps) {
  return (
    <div>
      <button
        onClick={() => onOpenChange(!open)}
        className={`flex items-center gap-2 text-sm font-medium text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0 ${FOCUS_RING}`}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Advanced Options
      </button>
      {open && (
        <div className="mt-3 space-y-4 pl-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={skipIfRunning}
              onChange={(event) => onSkipIfRunningChange(event.target.checked)}
              className="rounded border-border-default"
            />
            <span className="text-sm text-fg-primary">
              Skip if previous execution still running
            </span>
          </label>

          <div>
            <label htmlFor="max-concurrent" className="block text-sm text-fg-primary mb-1">
              Max concurrent runs
            </label>
            <input
              id="max-concurrent"
              type="number"
              min={1}
              max={DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT}
              value={maxConcurrent}
              onChange={(event) =>
                onMaxConcurrentChange(
                  Math.min(
                    DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
                    Math.max(1, Number.parseInt(event.target.value, 10) || 1)
                  )
                )
              }
              className={`w-20 px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
            />
          </div>

          {sourceType !== 'webhook' && (
            <TriggerProfileSelect
              profiles={profiles}
              value={agentProfileId}
              onChange={onAgentProfileChange}
            />
          )}

          <div>
            <label htmlFor="vm-size" className="block text-sm text-fg-primary mb-1">
              VM size
            </label>
            <select
              id="vm-size"
              value={vmSize}
              onChange={(event) => onVmSizeChange(event.target.value)}
              className={`px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
            >
              {VM_SIZES.map((size) => (
                <option key={size.value} value={size.value}>
                  {size.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="task-mode" className="block text-sm text-fg-primary mb-1">
              Task mode
            </label>
            <select
              id="task-mode"
              value={taskMode}
              onChange={(event) => onTaskModeChange(event.target.value as 'task' | 'conversation')}
              className={`px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
            >
              <option value="task">Task (run once, complete)</option>
              <option value="conversation">Conversation (interactive)</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
