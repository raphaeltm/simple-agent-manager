/**
 * TriggerForm — slide-over panel for creating/editing triggers.
 * Follows SettingsDrawer pattern (min(560px, 95vw)).
 */
import type {
  AgentProfile,
  CreateTriggerRequest,
  GitHubTriggerEventType,
  TriggerResponse,
  UpdateTriggerRequest,
  WebhookCredential,
  WebhookTriggerFilter,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useToast } from '../../hooks/useToast';
import { createTrigger, listAgentProfiles, updateTrigger } from '../../lib/api';
import { useProjectContext } from '../../pages/ProjectContext';
import { GitHubTriggerFields } from './GitHubTriggerFields';
import { SchedulePicker } from './SchedulePicker';
import {
  buildGitHubFilters,
  CRON_TEMPLATE_VARIABLES,
  FOCUS_RING,
  GITHUB_TEMPLATE_VARIABLES,
  joinList,
  splitList,
  WEBHOOK_TEMPLATE_VARIABLES,
} from './trigger-form-support';
import { TriggerAdvancedOptions } from './TriggerAdvancedOptions';
import { TriggerCredentialWarning } from './TriggerCredentialWarning';
import { TriggerIdentityFields } from './TriggerIdentityFields';
import { TriggerProfileSelect } from './TriggerProfileSelect';
import { TriggerPromptTemplate } from './TriggerPromptTemplate';
import { TriggerSourceSelector } from './TriggerSourceSelector';
import { WebhookTriggerFields } from './WebhookTriggerFields';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TriggerFormProps {
  open: boolean;
  onClose: () => void;
  /** If set, we're editing this trigger. Otherwise, creating new. */
  editTrigger?: TriggerResponse | null;
  /** Called after successful create/update. */
  onSaved?: (credential?: WebhookCredential, returnFocusTarget?: HTMLElement | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TriggerForm: FC<TriggerFormProps> = ({ open, onClose, editTrigger, onSaved }) => {
  const toast = useToast();
  const { projectId } = useProjectContext();
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(true);
  const isEdit = Boolean(editTrigger);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState<'cron' | 'github' | 'webhook'>('cron');
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
  const [webhookSourceLabel, setWebhookSourceLabel] = useState('');
  const [webhookIncludedHeaders, setWebhookIncludedHeaders] = useState('');
  const [webhookFilterMode, setWebhookFilterMode] = useState<'all' | 'any'>('all');
  const [webhookFilters, setWebhookFilters] = useState<WebhookTriggerFilter[]>([]);
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
      void listAgentProfiles(projectId)
        .then(setProfiles)
        .catch(() => setProfiles([]));
    }
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    shouldRestoreFocusRef.current = true;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (shouldRestoreFocusRef.current) returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  // Reset form when trigger changes or panel opens
  useEffect(() => {
    if (open) {
      if (editTrigger) {
        setName(editTrigger.name);
        setDescription(editTrigger.description ?? '');
        setSourceType(editTrigger.sourceType);
        setCronExpression(editTrigger.cronExpression ?? '0 9 * * *');
        setCronTimezone(editTrigger.cronTimezone);
        setGitHubEventType(editTrigger.githubConfig?.eventType ?? 'issue_comment');
        setGitHubActions(joinList(editTrigger.githubConfig?.filters.actions) || 'created');
        setGitHubLabels(joinList(editTrigger.githubConfig?.filters.labels));
        setGitHubIgnoreActors(
          joinList(editTrigger.githubConfig?.filters.ignoreActors) || 'dependabot[bot]'
        );
        setGitHubCommandPrefix(editTrigger.githubConfig?.filters.commandPrefix ?? '/sam');
        setGitHubBodyContains(editTrigger.githubConfig?.filters.bodyContains ?? '');
        setGitHubBranches(joinList(editTrigger.githubConfig?.filters.branches));
        setGitHubIgnoreDrafts(editTrigger.githubConfig?.filters.ignoreDrafts ?? true);
        setWebhookSourceLabel(editTrigger.webhookConfig?.sourceLabel ?? '');
        setWebhookIncludedHeaders(joinList(editTrigger.webhookConfig?.includedHeaders));
        setWebhookFilterMode(editTrigger.webhookConfig?.filterMode ?? 'all');
        setWebhookFilters(editTrigger.webhookConfig?.filters ?? []);
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
        setWebhookSourceLabel('');
        setWebhookIncludedHeaders('');
        setWebhookFilterMode('all');
        setWebhookFilters([]);
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

  const insertVariable = useCallback(
    (varName: string) => {
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
    },
    [promptTemplate]
  );

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
    if (sourceType === 'webhook' && !agentProfileId) {
      toast.error('Webhook triggers require an agent profile');
      return;
    }
    if (sourceType === 'webhook' && webhookFilters.some((filter) => !filter.path.trim())) {
      toast.error('Every webhook filter needs a path');
      return;
    }

    setSaving(true);
    try {
      let credential: WebhookCredential | undefined;
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
          webhookConfig:
            sourceType === 'webhook'
              ? {
                  sourceLabel: webhookSourceLabel.trim() || undefined,
                  includedHeaders: splitList(webhookIncludedHeaders),
                  filterMode: webhookFilterMode,
                  filters: webhookFilters,
                }
              : undefined,
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
          githubConfig:
            sourceType === 'github'
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
          webhookConfig:
            sourceType === 'webhook'
              ? {
                  sourceLabel: webhookSourceLabel.trim() || undefined,
                  includedHeaders: splitList(webhookIncludedHeaders),
                  filterMode: webhookFilterMode,
                  filters: webhookFilters,
                }
              : undefined,
        };
        const created = await createTrigger(projectId, data);
        credential = created.webhookCredential;
        toast.success('Trigger created');
      }
      // The one-time credential dialog becomes the active modal after creation.
      // Let it claim focus instead of returning focus to the form opener.
      shouldRestoreFocusRef.current = !credential;
      onSaved?.(credential, credential ? returnFocusRef.current : undefined);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save trigger';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [
    name,
    description,
    sourceType,
    cronExpression,
    cronTimezone,
    githubEventType,
    githubActions,
    githubLabels,
    githubIgnoreActors,
    githubCommandPrefix,
    githubBodyContains,
    githubBranches,
    githubIgnoreDrafts,
    webhookSourceLabel,
    webhookIncludedHeaders,
    webhookFilterMode,
    webhookFilters,
    promptTemplate,
    skipIfRunning,
    maxConcurrent,
    vmSizeOverride,
    taskMode,
    agentProfileId,
    isEdit,
    editTrigger,
    projectId,
    toast,
    onSaved,
    onClose,
  ]);

  const templateVariables =
    sourceType === 'github'
      ? GITHUB_TEMPLATE_VARIABLES
      : sourceType === 'webhook'
        ? WEBHOOK_TEMPLATE_VARIABLES
        : CRON_TEMPLATE_VARIABLES;
  const promptPlaceholder =
    sourceType === 'github'
      ? 'When {{github.actor}} comments {{github.comment}} on {{github.repository}}#{{github.number}}, decide whether to start the requested SAM task.'
      : sourceType === 'webhook'
        ? 'Process this untrusted webhook payload: {{webhook.payload}}'
        : 'Review all open pull requests and summarize their status. Current time: {{schedule.time}}';

  if (!open) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 glass-backdrop-dim z-[var(--sam-z-drawer-backdrop)]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        className="fixed top-0 right-0 bottom-0 glass-modal glass-panel-container glass-composited shadow-lg z-[var(--sam-z-drawer)] overflow-y-auto transition-transform duration-300 ease-out motion-reduce:transition-none translate-x-0"
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

        {editTrigger?.credentialAttribution?.multiplayerActive &&
          editTrigger.credentialAttribution.hasPersonalWarning && (
            <div className="px-4 pt-4">
              <TriggerCredentialWarning trigger={editTrigger} />
            </div>
          )}

        {/* Form content */}
        <div className="p-4 space-y-6">
          <TriggerIdentityFields
            description={description}
            name={name}
            onDescriptionChange={setDescription}
            onNameChange={setName}
          />

          <TriggerSourceSelector value={sourceType} disabled={isEdit} onChange={setSourceType} />

          {/* Schedule */}
          {sourceType === 'webhook' ? (
            <div className="space-y-4">
              <TriggerProfileSelect
                profiles={profiles}
                value={agentProfileId}
                required
                onChange={setAgentProfileId}
              />
              <WebhookTriggerFields
                sourceLabel={webhookSourceLabel}
                includedHeaders={webhookIncludedHeaders}
                filterMode={webhookFilterMode}
                filters={webhookFilters}
                onSourceLabelChange={setWebhookSourceLabel}
                onIncludedHeadersChange={setWebhookIncludedHeaders}
                onFilterModeChange={setWebhookFilterMode}
                onFiltersChange={setWebhookFilters}
              />
            </div>
          ) : sourceType === 'cron' ? (
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
            <GitHubTriggerFields
              actions={githubActions}
              bodyContains={githubBodyContains}
              branches={githubBranches}
              commandPrefix={githubCommandPrefix}
              disabled={isEdit}
              eventType={githubEventType}
              ignoreActors={githubIgnoreActors}
              ignoreDrafts={githubIgnoreDrafts}
              labels={githubLabels}
              onActionsChange={setGitHubActions}
              onBodyContainsChange={setGitHubBodyContains}
              onBranchesChange={setGitHubBranches}
              onCommandPrefixChange={setGitHubCommandPrefix}
              onEventTypeChange={setGitHubEventType}
              onIgnoreActorsChange={setGitHubIgnoreActors}
              onIgnoreDraftsChange={setGitHubIgnoreDrafts}
              onLabelsChange={setGitHubLabels}
            />
          )}

          <TriggerPromptTemplate
            onChange={setPromptTemplate}
            onInsertVariable={insertVariable}
            placeholder={promptPlaceholder}
            textareaRef={templateRef}
            value={promptTemplate}
            variables={templateVariables}
          />

          <TriggerAdvancedOptions
            agentProfileId={agentProfileId}
            maxConcurrent={maxConcurrent}
            onAgentProfileChange={setAgentProfileId}
            onMaxConcurrentChange={setMaxConcurrent}
            onOpenChange={setAdvancedOpen}
            onSkipIfRunningChange={setSkipIfRunning}
            onTaskModeChange={setTaskMode}
            onVmSizeChange={setVmSizeOverride}
            open={advancedOpen}
            profiles={profiles}
            skipIfRunning={skipIfRunning}
            sourceType={sourceType}
            taskMode={taskMode}
            vmSize={vmSizeOverride}
          />
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
            ) : isEdit ? (
              'Save Changes'
            ) : (
              'Create Trigger'
            )}
          </Button>
        </div>
      </div>
    </>,
    document.body
  );
};
