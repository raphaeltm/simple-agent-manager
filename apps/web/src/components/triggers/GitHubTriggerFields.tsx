import type { GitHubTriggerEventType } from '@simple-agent-manager/shared';
import {
  GITHUB_AUTHOR_ASSOCIATIONS,
  GITHUB_REVIEW_STATES,
  GITHUB_TRIGGER_ACTIONS,
  isGitHubCommentEvent,
  isGitHubPullRequestEvent,
} from '@simple-agent-manager/shared';
import { useState } from 'react';

import { CheckRow, Field } from '../../pages/automation/fields';
import { Disclosure } from '../../pages/automation/ui';
import {
  FOCUS_RING,
  GITHUB_EVENT_OPTIONS,
  githubFilterChoiceErrors,
  splitList,
} from './trigger-form-support';

interface ExtraFilters {
  actors?: string;
  addedLabel?: string;
  authorAssociation?: string;
  ignoreBots?: boolean;
  commentContains?: string;
  isPullRequest?: string;
  reviewStates?: string;
}
interface GitHubTriggerFieldsProps {
  extraFilters?: ExtraFilters;
  onExtraFiltersChange?: (patch: ExtraFilters) => void;
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
  extraFilters = {},
  onExtraFiltersChange,
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
  const hasMoreConditions = (event: GitHubTriggerEventType) =>
    Boolean(
      (event !== 'push' && bodyContains) ||
      (['issues', 'pull_request'].includes(event) && extraFilters.addedLabel) ||
      (isGitHubCommentEvent(event) && extraFilters.commentContains) ||
      (event === 'pull_request_review' && extraFilters.reviewStates)
    );
  const [moreOpen, setMoreOpen] = useState(() => hasMoreConditions(eventType));
  const choiceErrors: Partial<Record<keyof ExtraFilters, string>> = githubFilterChoiceErrors({
    authorAssociation:
      eventType !== 'push'
        ? splitList(extraFilters.authorAssociation?.toUpperCase() ?? '')
        : undefined,
    reviewStates:
      eventType === 'pull_request_review'
        ? splitList(extraFilters.reviewStates?.toLowerCase() ?? '')
        : undefined,
  });
  const text = (
    key: string,
    label: string,
    value: string,
    change: (value: string) => void,
    hint?: string,
    inactive = false,
    error?: string
  ) => (
    <Field key={key} label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type="text"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={value}
          onChange={(event) => change(event.target.value)}
          disabled={disabled || inactive}
          className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
        />
      )}
    </Field>
  );
  const extra = (key: keyof ExtraFilters, label: string, hint: string) =>
    text(
      key,
      label,
      String(extraFilters[key] ?? ''),
      (value) => onExtraFiltersChange?.({ [key]: value }),
      hint,
      false,
      choiceErrors[key]
    );
  return (
    <div className="flex flex-col gap-4">
      <Field label="GitHub event">
        {({ id }) => (
          <select
            id={id}
            value={eventType}
            onChange={(event) => {
              const next = event.target.value as GitHubTriggerEventType;
              setMoreOpen(hasMoreConditions(next));
              onEventTypeChange(next);
            }}
            disabled={disabled}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          >
            {GITHUB_EVENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {text(
        'actions',
        'Actions',
        actions,
        onActionsChange,
        eventType === 'push'
          ? 'Push events have no action filter.'
          : `Comma-separated actions, such as ${GITHUB_TRIGGER_ACTIONS[eventType].slice(0, 2).join(', ')}. Empty matches all actions.`,
        eventType === 'push'
      )}
      {eventType === 'issue_comment' && (
        <Field label="Comments on">
          {({ id }) => (
            <select
              id={id}
              value={extraFilters.isPullRequest ?? ''}
              disabled={disabled}
              onChange={(event) => onExtraFiltersChange?.({ isPullRequest: event.target.value })}
              className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
            >
              <option value="">Issues and pull requests</option>
              <option value="false">Issues only</option>
              <option value="true">Pull requests only</option>
            </select>
          )}
        </Field>
      )}
      {eventType !== 'push' &&
        text(
          'labels',
          'Required labels',
          labels,
          onLabelsChange,
          'All listed labels must be on the issue or pull request.'
        )}
      {isGitHubCommentEvent(eventType) &&
        text(
          'prefix',
          'Command prefix',
          commandPrefix,
          onCommandPrefixChange,
          'The comment or review body must start with this text. Empty allows any beginning.'
        )}
      {(isGitHubPullRequestEvent(eventType) || eventType === 'push') &&
        text(
          'branches',
          isGitHubPullRequestEvent(eventType) ? 'Source branches' : 'Branches',
          branches,
          onBranchesChange,
          'Comma-separated branch names.'
        )}
      {eventType !== 'push' && (
        <Disclosure
          title="More conditions"
          defaultOpen={moreOpen}
          onToggle={setMoreOpen}
          testId="github-more-conditions"
        >
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {text(
              'body',
              'Text contains',
              bodyContains,
              onBodyContainsChange,
              'Search the title, body or comment, ignoring case.'
            )}
            {['issues', 'pull_request'].includes(eventType) &&
              extra(
                'addedLabel',
                'Changed label',
                'Matches the label added or removed, only on label actions.'
              )}
            {isGitHubCommentEvent(eventType) &&
              extra(
                'commentContains',
                'Comment contains',
                'Search only the comment or review body, ignoring case.'
              )}
            {eventType === 'pull_request_review' &&
              extra(
                'reviewStates',
                'Review states',
                `Comma-separated: ${GITHUB_REVIEW_STATES.join(', ')}. Letter case does not matter.`
              )}
          </div>
        </Disclosure>
      )}
      <fieldset className="min-w-0 border-0 p-0 m-0">
        <legend className="mb-2 text-sm font-semibold">Who can start it</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {extra(
            'actors',
            'Allowed actors',
            'GitHub logins of the people acting, comma-separated. Empty allows anyone.'
          )}
          {text(
            'ignoreActors',
            'Ignore actors',
            ignoreActors,
            onIgnoreActorsChange,
            'GitHub logins to skip, comma-separated.'
          )}
          {eventType !== 'push' &&
            extra(
              'authorAssociation',
              'Author association',
              `Only when the person acting wrote it and has one of these roles: ${GITHUB_AUTHOR_ASSOCIATIONS.join(', ')}. Someone else editing or labeling it will not match. Letter case does not matter.`
            )}
        </div>
        <CheckRow
          checked={extraFilters.ignoreBots ?? false}
          disabled={disabled}
          onChange={(ignoreBots) => onExtraFiltersChange?.({ ignoreBots })}
          label="Ignore bot actors"
          hint="Only senders GitHub marks as users can start it; bots and unknown sender types are skipped."
        />
      </fieldset>
      {eventType === 'pull_request' && (
        <CheckRow
          checked={ignoreDrafts}
          disabled={disabled}
          onChange={onIgnoreDraftsChange}
          label="Ignore draft pull requests"
        />
      )}
    </div>
  );
}
