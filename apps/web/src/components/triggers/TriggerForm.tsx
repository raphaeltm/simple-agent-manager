/**
 * TriggerForm — slide-over panel for creating/editing triggers.
 * Follows SettingsDrawer pattern (min(560px, 95vw)).
 */
import type {
  AgentProfile,
  CreateTriggerRequest,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
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
import { ChevronDown, ChevronRight, Clock, Github, X } from 'lucide-react';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useToast } from '../../hooks/useToast';
import { createTrigger, listAgentProfiles, updateTrigger } from '../../lib/api';
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

const GITHUB_EVENT_OPTIONS: Array<{ value: GitHubTriggerEventType; label: string }> = [
  { value: 'issue_comment', label: 'Issue comment' },
  { value: 'issues', label: 'Issue' },
  { value: 'pull_request', label: 'Pull request' },
  { value: 'push', label: 'Push' },
];

/** Template variables available for prompt interpolation. */
const CRON_TEMPLATE_VARIABLES = [
  { group: 'schedule', vars: ['schedule.time', 'schedule.date', 'schedule.dayOfWeek', 'schedule.hour', 'schedule.minute', 'schedule.timezone'] },
  { group: 'trigger', vars: ['trigger.id', 'trigger.name', 'trigger.description', 'trigger.fireCount'] },
  { group: 'project', vars: ['project.id', 'project.name'] },
  { group: 'execution', vars: ['execution.id', 'execution.sequenceNumber'] },
];

const GITHUB_TEMPLATE_VARIABLES = [
  { group: 'github', vars: ['github.event', 'github.action', 'github.actor', 'github.repository', 'github.number', 'github.title', 'github.body', 'github.comment', 'github.labels', 'github.branch', 'github.sha'] },
  { group: 'trigger', vars: ['trigger.id', 'trigger.name', 'trigger.description', 'trigger.fireCount'] },
  { group: 'project', vars: ['project.id', 'project.name'] },
  { group: 'execution', vars: ['execution.id', 'execution.sequenceNumber'] },
];

function splitList(value: string): string[] | undefined {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function joinList(value?: string[]): string {
  return value?.join(', ') ?? '';
}

function buildGitHubFilters(input: {
  eventType: GitHubTriggerEventType;
  actions: string;
  labels: string;
  ignoreActors: string;
  commandPrefix: string;
  bodyContains: string;
  branches: string;
  ignoreDrafts: boolean;
}): GitHubTriggerFilters {
  const filters: GitHubTriggerFilters = {};
  const actions = splitList(input.actions);
  const labels = splitList(input.labels);
  const ignoreActors = splitList(input.ignoreActors);
  const branches = splitList(input.branches);

  if (actions) filters.actions = actions;
  if (labels) filters.labels = labels;
  if (ignoreActors) filters.ignoreActors = ignoreActors;
  if (input.commandPrefix.trim()) filters.commandPrefix = input.commandPrefix.trim();
  if (input.bodyContains.trim()) filters.bodyContains = input.bodyContains.trim();
  if (branches) filters.branches = branches;
  if (input.eventType === 'pull_request' && input.ignoreDrafts) filters.ignoreDrafts = true;

  return filters;
}

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
  const [sourceType, setSourceType] = useState<'cron' | 'github'>('cron');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [cronTimezone, setCronTimezone] = useState('UTC');
  const [githubEventType, setGitHubEventType] = useState<GitHubTriggerEventType>('issue_comment');
  const [githubActions, setGitHubActions] = useState('created');
  const [githubLabels, setGitHubLabels] = useState('');
  const [githubIgnoreActors, setGitHubIgnoreActors] = useState('dependabot[bot]');
  const [githubCommandPrefix, setGitHubCommandPrefix] = useState('/sam');
  const [githubBodyContains, setGitHubBodyContains] = useState('');
  const [githubBranches, setGitHubBranches] = useState('');
  const [githubIgnoreDrafts, setGitHubIgnoreDrafts] = useState(true);
  const [promptTemplate, setPromptTemplate] = useState('');
  const [skipIfRunning, setSkipIfRunning] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [vmSizeOverride, setVmSizeOverride] = useState('');
  const [taskMode, setTaskMode] = useState<'task' | 'conversation'>('task');
  const [agentProfileId, setAgentProfileId] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, setCronDescription] = useState('');

  // Agent profiles for the dropdown
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  useEffect(() => {
    if (open && projectId) {
      void listAgentProfiles(projectId).then(setProfiles).catch(() => setProfiles([]));
    }
  }, [open, projectId]);

  // Reset form when trigger changes or panel opens
  useEffect(() => {
    if (open) {
      if (editTrigger) {
        setName(editTrigger.name);
        setDescription(editTrigger.description ?? '');
        setSourceType(editTrigger.sourceType === 'github' ? 'github' : 'cron');
        setCronExpression(editTrigger.cronExpression ?? '0 9 * * *');
        setCronTimezone(editTrigger.cronTimezone);
        setGitHubEventType(editTrigger.githubConfig?.eventType ?? 'issue_comment');
        setGitHubActions(joinList(editTrigger.githubConfig?.filters.actions) || 'created');
        setGitHubLabels(joinList(editTrigger.githubConfig?.filters.labels));
        setGitHubIgnoreActors(joinList(editTrigger.githubConfig?.filters.ignoreActors) || 'dependabot[bot]');
        setGitHubCommandPrefix(editTrigger.githubConfig?.filters.commandPrefix ?? '/sam');
        setGitHubBodyContains(editTrigger.githubConfig?.filters.bodyContains ?? '');
        setGitHubBranches(joinList(editTrigger.githubConfig?.filters.branches));
        setGitHubIgnoreDrafts(editTrigger.githubConfig?.filters.ignoreDrafts ?? true);
        setPromptTemplate(editTrigger.promptTemplate);
        setSkipIfRunning(editTrigger.skipIfRunning);
        setMaxConcurrent(editTrigger.maxConcurrent);
        setVmSizeOverride(editTrigger.vmSizeOverride ?? '');
        setTaskMode(editTrigger.taskMode);
        setAgentProfileId(editTrigger.agentProfileId ?? '');
        setAdvancedOpen(false);
      } else {
        setName('');
        setDescription('');
        setSourceType('cron');
        setCronExpression('0 9 * * *');
        setCronTimezone('UTC');
        setGitHubEventType('issue_comment');
        setGitHubActions('created');
        setGitHubLabels('');
        setGitHubIgnoreActors('dependabot[bot]');
        setGitHubCommandPrefix('/sam');
        setGitHubBodyContains('');
        setGitHubBranches('');
        setGitHubIgnoreDrafts(true);
        setPromptTemplate('');
        setSkipIfRunning(true);
        setMaxConcurrent(1);
        setVmSizeOverride('');
        setTaskMode('task');
        setAgentProfileId('');
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
    if (sourceType === 'cron' && !cronExpression.trim()) {
      toast.error('Schedule is required');
      return;
    }

    setSaving(true);
    try {
      if (isEdit && editTrigger) {
        const data: UpdateTriggerRequest = {
          name: name.trim(),
          description: description.trim() || null,
          cronExpression: sourceType === 'cron' ? cronExpression : undefined,
          cronTimezone: sourceType === 'cron' ? cronTimezone : undefined,
          promptTemplate,
          skipIfRunning,
          maxConcurrent,
          vmSizeOverride: vmSizeOverride || null,
          taskMode,
          agentProfileId: agentProfileId || null,
        };
        await updateTrigger(projectId, editTrigger.id, data);
        toast.success('Trigger updated');
      } else {
        const data: CreateTriggerRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          sourceType,
          cronExpression: sourceType === 'cron' ? cronExpression : undefined,
          cronTimezone: sourceType === 'cron' ? cronTimezone : undefined,
          promptTemplate,
          skipIfRunning,
          maxConcurrent,
          vmSizeOverride: vmSizeOverride || undefined,
          taskMode,
          agentProfileId: agentProfileId || undefined,
          githubConfig: sourceType === 'github'
            ? {
                eventType: githubEventType,
                filters: buildGitHubFilters({
                  eventType: githubEventType,
                  actions: githubActions,
                  labels: githubLabels,
                  ignoreActors: githubIgnoreActors,
                  commandPrefix: githubCommandPrefix,
                  bodyContains: githubBodyContains,
                  branches: githubBranches,
                  ignoreDrafts: githubIgnoreDrafts,
                }),
              }
            : undefined,
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
    name, description, sourceType, cronExpression, cronTimezone,
    githubEventType, githubActions, githubLabels, githubIgnoreActors,
    githubCommandPrefix, githubBodyContains, githubBranches, githubIgnoreDrafts,
    promptTemplate,
    skipIfRunning, maxConcurrent, vmSizeOverride, taskMode, agentProfileId,
    isEdit, editTrigger, projectId, toast, onSaved, onClose,
  ]);

  const templateVariables = sourceType === 'github' ? GITHUB_TEMPLATE_VARIABLES : CRON_TEMPLATE_VARIABLES;
  const promptPlaceholder = sourceType === 'github'
    ? 'When {{github.actor}} comments {{github.comment}} on {{github.repository}}#{{github.number}}, decide whether to start the requested SAM task.'
    : 'Review all open pull requests and summarize their status. Current time: {{schedule.time}}';

  return createPortal(
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 glass-backdrop-dim z-[var(--sam-z-drawer-backdrop)]"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <div
        className={`fixed top-0 right-0 bottom-0 glass-modal glass-panel-container glass-composited shadow-lg z-[var(--sam-z-drawer)] overflow-y-auto transition-transform duration-300 ease-out motion-reduce:transition-none ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ width: 'min(560px, 95vw)' }}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit trigger' : 'Create trigger'}
      >
        {/* Header */}
        <div className="sticky top-0 glass-chrome p-4 flex items-center justify-between z-10">
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
              className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
              className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
              maxLength={DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH}
            />
          </div>

          {/* Source */}
          <div>
            <h3 className="text-sm font-medium text-fg-primary mb-2">Source</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSourceType('cron')}
                disabled={isEdit}
                className={`flex items-center gap-3 rounded-md border px-3 py-3 text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${
                  sourceType === 'cron'
                    ? 'border-accent bg-accent/10 text-fg-primary'
                    : 'border-border-default bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
                } ${FOCUS_RING}`}
                aria-pressed={sourceType === 'cron'}
              >
                <Clock size={18} aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium">Schedule</span>
                  <span className="block text-xs">Run on a cron schedule</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setSourceType('github')}
                disabled={isEdit}
                className={`flex items-center gap-3 rounded-md border px-3 py-3 text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${
                  sourceType === 'github'
                    ? 'border-accent bg-accent/10 text-fg-primary'
                    : 'border-border-default bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
                } ${FOCUS_RING}`}
                aria-pressed={sourceType === 'github'}
              >
                <Github size={18} aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium">GitHub event</span>
                  <span className="block text-xs">Run when repository events match</span>
                </span>
              </button>
            </div>
          </div>

          {/* Schedule */}
          {sourceType === 'cron' ? (
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
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="github-event-type" className="block text-sm font-medium text-fg-primary mb-1">
                  GitHub event
                </label>
                <select
                  id="github-event-type"
                  value={githubEventType}
                  onChange={(e) => setGitHubEventType(e.target.value as GitHubTriggerEventType)}
                  disabled={isEdit}
                  className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                >
                  {GITHUB_EVENT_OPTIONS.map((eventOption) => (
                    <option key={eventOption.value} value={eventOption.value}>
                      {eventOption.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="github-actions" className="block text-sm font-medium text-fg-primary mb-1">
                    Actions
                  </label>
                  <input
                    id="github-actions"
                    type="text"
                    value={githubActions}
                    onChange={(e) => setGitHubActions(e.target.value)}
                    placeholder="opened, labeled, created"
                    disabled={isEdit}
                    className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>
                <div>
                  <label htmlFor="github-ignore-actors" className="block text-sm font-medium text-fg-primary mb-1">
                    Ignore actors
                  </label>
                  <input
                    id="github-ignore-actors"
                    type="text"
                    value={githubIgnoreActors}
                    onChange={(e) => setGitHubIgnoreActors(e.target.value)}
                    placeholder="dependabot[bot]"
                    disabled={isEdit}
                    className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>
              </div>

              {(githubEventType === 'issues' || githubEventType === 'pull_request') && (
                <div>
                  <label htmlFor="github-labels" className="block text-sm font-medium text-fg-primary mb-1">
                    Required labels
                  </label>
                  <input
                    id="github-labels"
                    type="text"
                    value={githubLabels}
                    onChange={(e) => setGitHubLabels(e.target.value)}
                    placeholder="needs-agent, bug"
                    disabled={isEdit}
                    className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>
              )}

              {githubEventType === 'issue_comment' && (
                <div>
                  <label htmlFor="github-command-prefix" className="block text-sm font-medium text-fg-primary mb-1">
                    Command prefix
                  </label>
                  <input
                    id="github-command-prefix"
                    type="text"
                    value={githubCommandPrefix}
                    onChange={(e) => setGitHubCommandPrefix(e.target.value)}
                    placeholder="/sam"
                    disabled={isEdit}
                    className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>
              )}

              {(githubEventType === 'pull_request' || githubEventType === 'push') && (
                <div>
                  <label htmlFor="github-branches" className="block text-sm font-medium text-fg-primary mb-1">
                    Branches
                  </label>
                  <input
                    id="github-branches"
                    type="text"
                    value={githubBranches}
                    onChange={(e) => setGitHubBranches(e.target.value)}
                    placeholder="main, develop"
                    disabled={isEdit}
                    className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>
              )}

              {githubEventType !== 'push' && (
                <div>
                  <label htmlFor="github-body-contains" className="block text-sm font-medium text-fg-primary mb-1">
                    Text contains
                  </label>
                  <input
                    id="github-body-contains"
                    type="text"
                    value={githubBodyContains}
                    onChange={(e) => setGitHubBodyContains(e.target.value)}
                    placeholder="optional keyword"
                    disabled={isEdit}
                    className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>
              )}

              {githubEventType === 'pull_request' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={githubIgnoreDrafts}
                    onChange={(e) => setGitHubIgnoreDrafts(e.target.checked)}
                    disabled={isEdit}
                    className="rounded border-border-default"
                  />
                  <span className="text-sm text-fg-primary">Ignore draft pull requests</span>
                </label>
              )}
            </div>
          )}

          {/* Prompt Template */}
          <div>
            <h3 className="text-sm font-medium text-fg-primary mb-2">Prompt Template</h3>
            <div className="flex flex-col md:flex-row gap-3">
              <div className="flex-1 min-w-0">
                <textarea
                  ref={templateRef}
                  value={promptTemplate}
                  onChange={(e) => setPromptTemplate(e.target.value)}
                  placeholder={promptPlaceholder}
                  rows={6}
                  maxLength={DEFAULT_CRON_TEMPLATE_MAX_LENGTH}
                  className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm font-mono resize-y ${FOCUS_RING}`}
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
                  {templateVariables.map((group) => (
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
                    className={`w-20 px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  />
                </div>

                {/* Agent Profile */}
                <div>
                  <label htmlFor="agent-profile" className="block text-sm text-fg-primary mb-1">
                    Agent Profile
                  </label>
                  <select
                    id="agent-profile"
                    value={agentProfileId}
                    onChange={(e) => setAgentProfileId(e.target.value)}
                    className={`w-full px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
                  >
                    <option value="">Project default</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.model ? ` (${p.model})` : ''}
                      </option>
                    ))}
                  </select>
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
                    className={`px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
                    className={`px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
    </>,
    document.body,
  );
};
