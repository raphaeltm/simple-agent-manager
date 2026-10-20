import type { GitHubTriggerEventType } from '@simple-agent-manager/shared';
import { GITHUB_TRIGGER_ACTIONS } from '@simple-agent-manager/shared';

import { FOCUS_RING, GITHUB_EVENT_OPTIONS } from './trigger-form-support';

interface GitHubTriggerFieldsProps {
  actions: string;
  bodyContains: string;
  branches: string;
  commandPrefix: string;
  disabled: boolean;
  eventType: GitHubTriggerEventType;
  ignoreActors: string;
  ignoreDrafts: boolean;
  labels: string;
  onActionsChange: (value: string) => void;
  onBodyContainsChange: (value: string) => void;
  onBranchesChange: (value: string) => void;
  onCommandPrefixChange: (value: string) => void;
  onEventTypeChange: (value: GitHubTriggerEventType) => void;
  onIgnoreActorsChange: (value: string) => void;
  onIgnoreDraftsChange: (value: boolean) => void;
  onLabelsChange: (value: string) => void;
}

export function GitHubTriggerFields({
  actions,
  bodyContains,
  branches,
  commandPrefix,
  disabled,
  eventType,
  ignoreActors,
  ignoreDrafts,
  labels,
  onActionsChange,
  onBodyContainsChange,
  onBranchesChange,
  onCommandPrefixChange,
  onEventTypeChange,
  onIgnoreActorsChange,
  onIgnoreDraftsChange,
  onLabelsChange,
}: GitHubTriggerFieldsProps) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label
          htmlFor="github-event-type"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          GitHub event
        </label>
        <select
          id="github-event-type"
          value={eventType}
          onChange={(event) => onEventTypeChange(event.target.value as GitHubTriggerEventType)}
          disabled={disabled}
          className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
        >
          {GITHUB_EVENT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="github-actions"
            className="block text-sm font-medium text-fg-primary mb-1"
          >
            Actions
          </label>
          <input
            id="github-actions"
            type="text"
            value={actions}
            onChange={(event) => onActionsChange(event.target.value)}
            placeholder={GITHUB_TRIGGER_ACTIONS[eventType].slice(0, 2).join(', ')}
            disabled={disabled || eventType === 'push'}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          />
          <p className="text-xs text-fg-muted mt-1">
            {eventType === 'push'
              ? 'Push events have no action filter.'
              : 'Comma-separated actions. Empty matches all actions.'}
          </p>
        </div>
        <div>
          <label
            htmlFor="github-ignore-actors"
            className="block text-sm font-medium text-fg-primary mb-1"
          >
            Ignore actors
          </label>
          <input
            id="github-ignore-actors"
            type="text"
            value={ignoreActors}
            onChange={(event) => onIgnoreActorsChange(event.target.value)}
            placeholder="dependabot[bot]"
            disabled={disabled}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          />
        </div>
      </div>

      {eventType !== 'push' && (
        <div>
          <label htmlFor="github-labels" className="block text-sm font-medium text-fg-primary mb-1">
            Required labels
          </label>
          <input
            id="github-labels"
            type="text"
            value={labels}
            onChange={(event) => onLabelsChange(event.target.value)}
            placeholder="needs-agent, bug"
            disabled={disabled}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          />
        </div>
      )}

      {eventType === 'issue_comment' && (
        <div>
          <label
            htmlFor="github-command-prefix"
            className="block text-sm font-medium text-fg-primary mb-1"
          >
            Command prefix
          </label>
          <input
            id="github-command-prefix"
            type="text"
            value={commandPrefix}
            onChange={(event) => onCommandPrefixChange(event.target.value)}
            placeholder="/sam"
            disabled={disabled}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          />
        </div>
      )}

      {(eventType === 'pull_request' || eventType === 'push') && (
        <div>
          <label
            htmlFor="github-branches"
            className="block text-sm font-medium text-fg-primary mb-1"
          >
            {eventType === 'pull_request' ? 'Source branches' : 'Branches'}
          </label>
          <input
            id="github-branches"
            type="text"
            value={branches}
            onChange={(event) => onBranchesChange(event.target.value)}
            placeholder="main, develop"
            disabled={disabled}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          />
        </div>
      )}

      {eventType !== 'push' && (
        <div>
          <label
            htmlFor="github-body-contains"
            className="block text-sm font-medium text-fg-primary mb-1"
          >
            Text contains
          </label>
          <input
            id="github-body-contains"
            type="text"
            value={bodyContains}
            onChange={(event) => onBodyContainsChange(event.target.value)}
            placeholder="optional keyword"
            disabled={disabled}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          />
        </div>
      )}

      {eventType === 'pull_request' && (
        <label className="flex min-h-11 items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-border-default"
            checked={ignoreDrafts}
            onChange={(event) => onIgnoreDraftsChange(event.target.checked)}
            disabled={disabled}
          />
          <span className="text-sm text-fg-primary">Ignore draft pull requests</span>
        </label>
      )}
    </div>
  );
}
