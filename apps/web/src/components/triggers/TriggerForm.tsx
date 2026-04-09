/**
 * TriggerForm — slide-over panel for creating/editing triggers.
 * Follows SettingsDrawer pattern (min(560px, 95vw)).
 */
import type {
  CreateTriggerRequest,
  TriggerResponse,
  UpdateTriggerRequest,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { createTrigger, updateTrigger } from '../../lib/api';
import { useProjectContext } from '../../pages/ProjectContext';
import { SchedulePicker } from './SchedulePicker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const VM_SIZES = [
  { value: '', label: 'Project default' },
  { value: 'small', label: 'Small (2 vCPU, 4 GB)' },
  { value: 'medium', label: 'Medium (4 vCPU, 8 GB)' },
  { value: 'large', label: 'Large (8 vCPU, 16 GB)' },
];

/** Template variables available for prompt interpolation. */
const TEMPLATE_VARIABLES = [
  { group: 'schedule', vars: ['schedule.time', 'schedule.date', 'schedule.dayOfWeek', 'schedule.hour', 'schedule.minute', 'schedule.timezone'] },
  { group: 'trigger', vars: ['trigger.id', 'trigger.name', 'trigger.description', 'trigger.fireCount'] },
  { group: 'project', vars: ['project.id', 'project.name'] },
  { group: 'execution', vars: ['execution.id', 'execution.sequenceNumber'] },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TriggerFormProps {
  open: boolean;
  onClose: () => void;
  /** If set, we're editing this trigger. Otherwise, creating new. */
  editTrigger?: TriggerResponse | null;
  /** Called after successful create/update. */
  onSaved?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TriggerForm: FC<TriggerFormProps> = ({
  open,
  onClose,
  editTrigger,
  onSaved,
}) => {
  const toast = useToast();
  const { projectId } = useProjectContext();
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const isEdit = Boolean(editTrigger);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [cronTimezone, setCronTimezone] = useState('UTC');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [skipIfRunning, setSkipIfRunning] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [vmSizeOverride, setVmSizeOverride] = useState('');
  const [taskMode, setTaskMode] = useState<'task' | 'conversation'>('task');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, setCronDescription] = useState('');

  // Reset form when trigger changes or panel opens
  useEffect(() => {
    if (open) {
      if (editTrigger) {
        setName(editTrigger.name);
        setDescription(editTrigger.description ?? '');
        setCronExpression(editTrigger.cronExpression ?? '0 9 * * *');
        setCronTimezone(editTrigger.cronTimezone);
        setPromptTemplate(editTrigger.promptTemplate);
        setSkipIfRunning(editTrigger.skipIfRunning);
        setMaxConcurrent(editTrigger.maxConcurrent);
        setVmSizeOverride(editTrigger.vmSizeOverride ?? '');
        setTaskMode(editTrigger.taskMode);
        setAdvancedOpen(false);
      } else {
        setName('');
        setDescription('');
        setCronExpression('0 9 * * *');
        setCronTimezone('UTC');
        setPromptTemplate('');
        setSkipIfRunning(true);
        setMaxConcurrent(1);
        setVmSizeOverride('');
        setTaskMode('task');
        setAdvancedOpen(false);
      }
    }
  }, [open, editTrigger]);

  const insertVariable = useCallback((varName: string) => {
    const textarea = templateRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = promptTemplate;
    const insertion = `{{${varName}}}`;
    const newText = text.substring(0, start) + insertion + text.substring(end);
    setPromptTemplate(newText);
    // Restore cursor position after insertion
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + insertion.length, start + insertion.length);
    });
  }, [promptTemplate]);

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!promptTemplate.trim()) {
      toast.error('Prompt template is required');
      return;
    }
    if (!cronExpression.trim()) {
      toast.error('Schedule is required');
      return;
    }

    setSaving(true);
    try {
      if (isEdit && editTrigger) {
        const data: UpdateTriggerRequest = {
          name: name.trim(),
          description: description.trim() || null,
          cronExpression,
          cronTimezone,
          promptTemplate,
          skipIfRunning,
          maxConcurrent,
          vmSizeOverride: vmSizeOverride || null,
          taskMode,
        };
        await updateTrigger(projectId, editTrigger.id, data);
        toast.success('Trigger updated');
      } else {
        const data: CreateTriggerRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          sourceType: 'cron',
          cronExpression,
          cronTimezone,
          promptTemplate,
          skipIfRunning,
          maxConcurrent,
          vmSizeOverride: vmSizeOverride || undefined,
          taskMode,
        };
        await createTrigger(projectId, data);
        toast.success('Trigger created');
      }
      onSaved?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save trigger';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [
    name, description, cronExpression, cronTimezone, promptTemplate,
    skipIfRunning, maxConcurrent, vmSizeOverride, taskMode,
    isEdit, editTrigger, projectId, toast, onSaved, onClose,
  ]);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-[var(--sam-z-drawer-backdrop)]"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <div
        className={`fixed top-0 right-0 bottom-0 bg-surface shadow-lg z-[var(--sam-z-drawer)] overflow-y-auto transition-transform duration-300 ease-out motion-reduce:transition-none ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ width: 'min(560px, 95vw)' }}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit trigger' : 'Create trigger'}
      >
        {/* Header */}
        <div className="sticky top-0 bg-surface border-b border-border-default p-4 flex items-center justify-between z-10">
          <h2 className="sam-type-section-heading m-0">
            {isEdit ? 'Edit Trigger' : 'New Trigger'}
          </h2>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer ${FOCUS_RING}`}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Form content */}
        <div className="p-4 space-y-6">
          {/* Name */}
          <div>
            <label htmlFor="trigger-name" className="block text-sm font-medium text-fg-primary mb-1">
              Name
            </label>
            <input
              id="trigger-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily code review"
              className={`w-full px-3 py-2 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
              maxLength={DEFAULT_TRIGGER_NAME_MAX_LENGTH}
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="trigger-description" className="block text-sm font-medium text-fg-primary mb-1">
              Description <span className="text-fg-muted font-normal">(optional)</span>
            </label>
            <input
              id="trigger-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Runs a daily code review on the main branch"
              className={`w-full px-3 py-2 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
              maxLength={DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH}
            />
          </div>

          {/* Schedule */}
          <div>
            <h3 className="text-sm font-medium text-fg-primary mb-2">Schedule</h3>
            <SchedulePicker
              value={cronExpression}
              onChange={setCronExpression}
              onDescriptionChange={setCronDescription}
              timezone={cronTimezone}
              onTimezoneChange={setCronTimezone}
            />
          </div>

          {/* Prompt Template */}
          <div>
            <h3 className="text-sm font-medium text-fg-primary mb-2">Prompt Template</h3>
            <div className="flex flex-col md:flex-row gap-3">
              <div className="flex-1 min-w-0">
                <textarea
                  ref={templateRef}
                  value={promptTemplate}
                  onChange={(e) => setPromptTemplate(e.target.value)}
                  placeholder="Review all open pull requests and summarize their status. Current time: {{schedule.time}}"
                  rows={6}
                  maxLength={DEFAULT_CRON_TEMPLATE_MAX_LENGTH}
                  className={`w-full px-3 py-2 rounded-md border border-border-default bg-surface text-fg-primary text-sm font-mono resize-y ${FOCUS_RING}`}
                  aria-label="Prompt template"
                />
                <p className="text-xs text-fg-muted mt-1 m-0">
                  {promptTemplate.length}/{DEFAULT_CRON_TEMPLATE_MAX_LENGTH} characters
                </p>
              </div>
              {/* Variable sidebar */}
              <div className="md:w-48 shrink-0">
                <p className="text-xs font-medium text-fg-muted mb-2 m-0">Available Variables</p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {TEMPLATE_VARIABLES.map((group) => (
                    <div key={group.group}>
                      <p className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1 m-0">
                        {group.group}
                      </p>
                      {group.vars.map((v) => (
                        <button
                          key={v}
                          onClick={() => insertVariable(v)}
                          className={`block w-full text-left px-2 py-1 text-xs font-mono text-accent hover:bg-surface-hover rounded cursor-pointer bg-transparent border-none ${FOCUS_RING}`}
                          title={`Insert {{${v}}}`}
                        >
                          {`{{${v}}}`}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Advanced Options */}
          <div>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className={`flex items-center gap-2 text-sm font-medium text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0 ${FOCUS_RING}`}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              Advanced Options
            </button>
            {advancedOpen && (
              <div className="mt-3 space-y-4 pl-6">
                {/* Skip if running */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipIfRunning}
                    onChange={(e) => setSkipIfRunning(e.target.checked)}
                    className="rounded border-border-default"
                  />
                  <span className="text-sm text-fg-primary">Skip if previous execution still running</span>
                </label>

                {/* Max concurrent */}
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
                    onChange={(e) => setMaxConcurrent(Math.min(DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                    className={`w-20 px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>

                {/* VM size */}
                <div>
                  <label htmlFor="vm-size" className="block text-sm text-fg-primary mb-1">
                    VM size
                  </label>
                  <select
                    id="vm-size"
                    value={vmSizeOverride}
                    onChange={(e) => setVmSizeOverride(e.target.value)}
                    className={`px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
                  >
                    {VM_SIZES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>

                {/* Task mode */}
                <div>
                  <label htmlFor="task-mode" className="block text-sm text-fg-primary mb-1">
                    Task mode
                  </label>
                  <select
                    id="task-mode"
                    value={taskMode}
                    onChange={(e) => setTaskMode(e.target.value as 'task' | 'conversation')}
                    className={`px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
                  >
                    <option value="task">Task (run once, complete)</option>
                    <option value="conversation">Conversation (interactive)</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 bg-surface border-t border-border-default p-4 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className={`px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg-primary bg-transparent border border-border-default rounded-md cursor-pointer ${FOCUS_RING}`}
          >
            Cancel
          </button>
          <Button
            onClick={handleSubmit}
            disabled={saving || !name.trim() || !promptTemplate.trim()}
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" /> Saving...
              </span>
            ) : (
              isEdit ? 'Save Changes' : 'Create Trigger'
            )}
          </Button>
        </div>
      </div>
    </>
  );
};
