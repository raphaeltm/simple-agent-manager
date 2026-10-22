/** Steps 1 and 2 of the create/edit flow: what starts it, and the details of when. */
import { GITHUB_TRIGGER_DEFAULT_ACTIONS } from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';

import { EmailTriggerFields } from '../../../components/triggers/EmailTriggerFields';
import { GitHubTriggerFields } from '../../../components/triggers/GitHubTriggerFields';
import { WebhookTriggerFields } from '../../../components/triggers/WebhookTriggerFields';
import type { AutomationStart } from '../../../lib/automation-routes';
import { ChoiceCards } from '../fields';
import { Notice } from '../page';
import { OnceTimeFields } from '../schedule-time';
import { KindIcon } from '../ui';
import type { Errors } from './requests';
import type { EditorState } from './state';
import { ScheduleWhen } from './when-schedule';
import { WatchWhen } from './when-watch';

const STARTS: Array<{ id: AutomationStart; title: string; text: string; advanced?: boolean }> = [
  {
    id: 'schedule',
    title: 'On a schedule',
    text: 'Every day, on weekdays, weekly, monthly or every few hours.',
  },
  {
    id: 'once',
    title: 'Once, at a time you pick',
    text: 'Start work later, or remind a chat about something.',
  },
  {
    id: 'github',
    title: 'When something happens on GitHub',
    text: 'New issues, comments, pull requests or pushes.',
  },
  {
    id: 'webhook',
    title: 'When another service calls SAM',
    text: 'Your CI, monitoring or app sends a request.',
  },
  {
    id: 'email',
    title: 'By email',
    text: 'SAM gives it its own address. An email from an allowed sender starts it, and the agent can reply.',
  },
  {
    id: 'event',
    title: 'When SAM sees an event',
    text: 'A task or release fails, a review arrives, an agent posts on a channel.',
    advanced: true,
  },
];

export function StepStart({
  value,
  onChange,
  emailAvailable,
}: {
  value: EditorState['start'];
  onChange: (start: AutomationStart) => void;
  /**
   * Whether this deployment configured agent email. The Email start is hidden until it has:
   * production does not offer the preview at all, so a disabled card would only add noise.
   */
  emailAvailable: boolean;
}) {
  return (
    <ChoiceCards
      label="What should start it?"
      value={value === 'incident' ? null : value}
      onChange={onChange}
      columns={1}
      options={STARTS.filter((start) => start.id !== 'email' || emailAvailable).map((start) => ({
        id: start.id,
        title: start.title,
        text: start.text,
        icon: (
          <span className="flex items-center gap-2">
            <KindIcon start={start.id} />
            {start.advanced && <StatusBadge status="pending" label="Advanced" pulse={false} />}
          </span>
        ),
      }))}
    />
  );
}

export function StepWhen({
  state,
  onChange,
  errors,
  creating,
}: {
  state: EditorState;
  onChange: (state: EditorState) => void;
  errors: Errors;
  /** False when editing: the webhook's URL and token already exist. */
  creating: boolean;
}) {
  switch (state.start) {
    case 'schedule':
      return (
        <ScheduleWhen
          value={state.schedule}
          error={errors.schedule}
          onChange={(schedule) => onChange({ ...state, schedule, scheduleTouched: true })}
        />
      );
    case 'once':
      return (
        <OnceTimeFields
          value={state.once}
          error={errors.once}
          onChange={(once) => onChange({ ...state, once })}
        />
      );
    case 'github': {
      const github = state.github;
      const set = (patch: Partial<EditorState['github']>) =>
        onChange({ ...state, github: { ...github, ...patch } });
      return (
        <div className="flex flex-col gap-3">
          <GitHubTriggerFields
            actions={github.actions}
            bodyContains={github.bodyContains}
            branches={github.branches}
            commandPrefix={github.commandPrefix}
            disabled={false}
            eventType={github.eventType}
            ignoreActors={github.ignoreActors}
            ignoreDrafts={github.ignoreDrafts}
            labels={github.labels}
            onActionsChange={(actions) => set({ actions })}
            onBodyContainsChange={(bodyContains) => set({ bodyContains })}
            onBranchesChange={(branches) => set({ branches })}
            onCommandPrefixChange={(commandPrefix) => set({ commandPrefix })}
            onEventTypeChange={(eventType) =>
              // A new event resets its actions and clears filters the event does not have.
              set({
                eventType,
                actions: GITHUB_TRIGGER_DEFAULT_ACTIONS[eventType],
                ...(eventType === 'push' ? { labels: '', bodyContains: '' } : {}),
                ...(eventType !== 'push' && eventType !== 'pull_request' ? { branches: '' } : {}),
              })
            }
            onIgnoreActorsChange={(ignoreActors) => set({ ignoreActors })}
            onIgnoreDraftsChange={(ignoreDrafts) => set({ ignoreDrafts })}
            onLabelsChange={(labels) => set({ labels })}
          />
          {errors.github && (
            <p role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
              {errors.github}
            </p>
          )}
        </div>
      );
    }
    case 'webhook': {
      const webhook = state.webhook;
      const set = (patch: Partial<EditorState['webhook']>) =>
        onChange({ ...state, webhook: { ...webhook, ...patch } });
      return (
        <div className="flex flex-col gap-3">
          <Notice>
            {creating
              ? 'After you create it, SAM shows the URL and a secret token once. Paste both into the service that will call it.'
              : 'Saving keeps its URL and token. To replace the token, use Get a new token on its page.'}
          </Notice>
          <WebhookTriggerFields
            sourceLabel={webhook.sourceLabel}
            includedHeaders={webhook.includedHeaders}
            filterMode={webhook.filterMode}
            filters={webhook.filters}
            onSourceLabelChange={(sourceLabel) => set({ sourceLabel })}
            onIncludedHeadersChange={(includedHeaders) => set({ includedHeaders })}
            onFilterModeChange={(filterMode) => set({ filterMode })}
            onFiltersChange={(filters) => set({ filters })}
          />
          {errors.webhook && (
            <p role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
              {errors.webhook}
            </p>
          )}
        </div>
      );
    }
    case 'email': {
      const email = state.email;
      return (
        <div className="flex flex-col gap-3">
          <Notice>
            {creating
              ? 'SAM gives this automation its own email address once you save it. Only the senders below can start it, and the agent can reply to them by email.'
              : 'Its address stays the same — see it on this automation’s page. Saving changes who may use it.'}
          </Notice>
          <EmailTriggerFields
            allowedSenders={email.allowedSenders}
            onAllowedSendersChange={(allowedSenders) =>
              onChange({ ...state, email: { ...email, allowedSenders } })
            }
            error={errors.email}
          />
        </div>
      );
    }
    case 'event':
      return (
        <WatchWhen
          value={state.watch}
          errors={{ watch: errors.watch, limits: errors.limits }}
          onChange={(watch) => onChange({ ...state, watch })}
        />
      );
    case 'incident':
      return (
        <Notice tone="info">
          Only the scheduled incident sweep starts this automation, so there is nothing to set here.
        </Notice>
      );
    default:
      return null;
  }
}
