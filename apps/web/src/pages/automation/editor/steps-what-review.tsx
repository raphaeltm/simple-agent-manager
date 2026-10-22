/** Steps 3 and 4 of the create/edit flow: what happens, then a plain-language review. */
import {
  DEFAULT_AGENT_EFFORT,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
} from '@simple-agent-manager/shared';
import { Bot, MessageSquare, Plus } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

import {
  ResourceRequirementsInput,
  validateResourceState,
} from '../../../components/resource-requirements';
import {
  CRON_TEMPLATE_VARIABLES,
  EFFORT_LABELS,
  EMAIL_TEMPLATE_VARIABLES,
  GITHUB_TEMPLATE_VARIABLES,
  INCIDENT_TEMPLATE_VARIABLES,
  WEBHOOK_TEMPLATE_VARIABLES,
} from '../../../components/triggers/trigger-form-support';
import { AUTOMATION_CHAT_PICKER_LIMIT } from '../../../lib/automation-config';
import type { AutomationLookups } from '../data';
import { CheckRow, ChoiceCards, Field, INPUT_CLASS } from '../fields';
import { fullDate } from '../time';
import { Disclosure, Panel, PromptText } from '../ui';
import { nextRuns } from './cron';
import type { Errors } from './requests';
import { canMessageChat, type EditorState, isTriggerStart } from './state';
import { whenSentence } from './when-sentence';

const VARIABLES = {
  schedule: CRON_TEMPLATE_VARIABLES,
  github: GITHUB_TEMPLATE_VARIABLES,
  webhook: WEBHOOK_TEMPLATE_VARIABLES,
  email: EMAIL_TEMPLATE_VARIABLES,
  incident: INCIDENT_TEMPLATE_VARIABLES,
} as const;

const iconBox = (icon: ReactNode, className: string) => (
  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${className}`}>
    {icon}
  </span>
);

export function StepWhat({
  state,
  onChange,
  errors,
  lookups,
  lockedNote,
}: {
  state: EditorState;
  onChange: (state: EditorState) => void;
  errors: Errors;
  lookups: AutomationLookups;
  /** Set when the person may not change what this does (a watch someone else created). */
  lockedNote?: string;
}) {
  const { action } = state;
  const set = (patch: Partial<EditorState['action']>) =>
    onChange({ ...state, action: { ...action, ...patch } });
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [showVariables, setShowVariables] = useState(false);
  const variables =
    state.start && state.start in VARIABLES
      ? VARIABLES[state.start as keyof typeof VARIABLES]
      : null;

  if (lockedNote) {
    return (
      <Panel className="flex flex-col gap-3 p-4" label="What it does">
        <p className="m-0 text-sm text-fg-muted">{lockedNote}</p>
        <p className="m-0 text-[15px] text-fg-primary">
          {action.kind === 'message'
            ? `Sends a message to “${lookups.chatTitle(action.sessionId)}”`
            : `Starts a new chat with ${lookups.profileName(action.agentProfileId || null)}`}
        </p>
        <blockquote className="m-0 whitespace-pre-wrap break-words rounded-lg border-0 border-l-2 border-solid border-accent bg-inset px-4 py-3 text-sm text-fg-primary">
          <PromptText text={action.prompt} />
        </blockquote>
      </Panel>
    );
  }

  const insert = (variable: string) => {
    const textarea = promptRef.current;
    const token = `{{${variable}}}`;
    const start = textarea?.selectionStart ?? action.prompt.length;
    const end = textarea?.selectionEnd ?? action.prompt.length;
    set({ prompt: `${action.prompt.slice(0, start)}${token}${action.prompt.slice(end)}` });
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // A watch acts as its creator, and may only message chats they own (the runner pauses it
  // otherwise), so it offers only those. A one-time message may also go to a chat shared with
  // you, which the list cannot tell apart; the API checks that when it is sent.
  const chats =
    state.start === 'event' ? lookups.chats.filter((chat) => chat.isMine !== false) : lookups.chats;
  const knownChat = chats.some((chat) => chat.id === action.sessionId);
  const truncated = lookups.chats.length >= AUTOMATION_CHAT_PICKER_LIMIT;
  return (
    <div className="flex flex-col gap-6">
      {canMessageChat(state.start) && (
        <ChoiceCards
          label="What should happen?"
          value={action.kind}
          onChange={(kind) => set({ kind })}
          options={[
            {
              id: 'start',
              title: 'Start a new chat',
              text: 'An agent picks up the work. You can read or reply any time.',
              icon: iconBox(
                <Bot size={18} aria-hidden />,
                'bg-[var(--sam-color-accent-primary-tint)] text-accent'
              ),
            },
            {
              id: 'message',
              title: 'Message a chat',
              text: 'Send a note to a chat that already exists, even if it is asleep.',
              icon: iconBox(<MessageSquare size={18} aria-hidden />, 'bg-info-tint text-info-fg'),
            },
          ]}
        />
      )}
      {action.kind === 'message' ? (
        <Field
          label="Which chat?"
          error={errors.sessionId}
          hint={`${
            state.start === 'event'
              ? 'A watch acts as the person who creates it, so it can only message chats they own.'
              : 'A chat you own, or one shared with you. If it is busy, the message waits its turn.'
          }${
            truncated
              ? ` Only the ${AUTOMATION_CHAT_PICKER_LIMIT} most recent chats are listed; for an older one, open it and use Automation → Remind this chat later.`
              : ''
          }`}
        >
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              value={action.sessionId}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(event) => set({ sessionId: event.target.value })}
            >
              <option value="">Pick a chat</option>
              {action.sessionId && !knownChat && (
                <option value={action.sessionId}>{lookups.chatTitle(action.sessionId)}</option>
              )}
              {chats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chat.topic?.trim() || `Chat ${chat.id.slice(0, 8)}`}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Agent"
            error={errors.agentProfileId}
            hint={
              state.start === 'webhook'
                ? 'Webhook runs always use the profile you pick here.'
                : state.start === 'email'
                  ? 'Email runs always use the profile you pick here.'
                  : 'Decides the model, tools and machine.'
            }
          >
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                value={action.agentProfileId}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => set({ agentProfileId: event.target.value })}
              >
                <option value="">
                  {state.start === 'webhook' || state.start === 'email'
                    ? 'Pick a profile'
                    : 'Project default'}
                </option>
                {lookups.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.model ? ` (${profile.model})` : ''}
                    {profile.effort !== DEFAULT_AGENT_EFFORT
                      ? ` · ${EFFORT_LABELS[profile.effort]}`
                      : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Skill" optional hint="Extra instructions the agent loads for this work.">
            {({ id, describedBy }) => (
              <select
                id={id}
                value={action.skillId}
                aria-describedby={describedBy}
                onChange={(event) => set({ skillId: event.target.value })}
              >
                <option value="">No extra skill</option>
                {action.skillId && !lookups.skills.some((skill) => skill.id === action.skillId) && (
                  <option value={action.skillId}>{lookups.skillName(action.skillId)}</option>
                )}
                {lookups.skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      )}
      <Field
        label={action.kind === 'message' ? 'What should the message say?' : 'What should it do?'}
        error={errors.prompt}
        hint={
          variables
            ? `Write it like a message to the agent. ${action.prompt.length}/${DEFAULT_CRON_TEMPLATE_MAX_LENGTH} characters.`
            : 'Write it like a message to the agent.'
        }
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            ref={promptRef}
            rows={6}
            maxLength={variables ? DEFAULT_CRON_TEMPLATE_MAX_LENGTH : undefined}
            value={action.prompt}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            onChange={(event) => set({ prompt: event.target.value })}
            className="leading-relaxed"
          />
        )}
      </Field>
      {variables && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            aria-expanded={showVariables}
            onClick={() => setShowVariables((value) => !value)}
            className="inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-md border border-border-default bg-transparent px-4 text-sm font-semibold text-fg-primary hover:bg-surface-hover"
          >
            <Plus size={16} aria-hidden /> Add a detail from the run
          </button>
          {showVariables && (
            <div
              className="flex flex-col gap-3 rounded-xl border border-border-default p-3"
              role="group"
              aria-label="Details you can add"
            >
              {variables.map((group) => (
                <div key={group.group} className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    {group.group}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {group.vars.map((variable) => (
                      <button
                        key={variable}
                        type="button"
                        onClick={() => insert(variable)}
                        className="min-h-11 cursor-pointer rounded-full border border-border-default bg-transparent px-3 font-mono text-[13px] text-fg-primary hover:bg-surface-hover"
                      >
                        {variable.split('.').slice(1).join('.')}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StepReview({
  state,
  onChange,
  errors,
  lookups,
  saveError,
}: {
  state: EditorState;
  onChange: (state: EditorState) => void;
  errors: Errors;
  lookups: AutomationLookups;
  saveError: string | null;
}) {
  const trigger = isTriggerStart(state.start);
  const { action } = state;
  const then =
    action.kind === 'message'
      ? `send a message to “${lookups.chatTitle(action.sessionId)}”`
      : `start a new chat with ${lookups.profileName(action.agentProfileId || null)}`;
  const first = state.start === 'schedule' ? nextRuns(state.schedule, Date.now(), 1)[0] : undefined;
  const set = (patch: Partial<EditorState['trigger']>) =>
    onChange({ ...state, trigger: { ...state.trigger, ...patch } });
  return (
    <div className="flex flex-col gap-6">
      <Panel className="flex flex-col gap-3 p-4 md:p-5" label="Summary">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          This automation will
        </span>
        <p
          className="m-0 text-[17px] leading-relaxed text-fg-primary [overflow-wrap:anywhere]"
          data-testid="automation-sentence"
        >
          <strong>{whenSentence(state)}</strong>, {then}
          {action.prompt.trim() ? ':' : '.'}
        </p>
        {action.prompt.trim() && (
          <p className="m-0 line-clamp-4 whitespace-pre-wrap text-sm text-fg-muted [overflow-wrap:anywhere]">
            <PromptText text={action.prompt} />
          </p>
        )}
        {first && <span className="text-[13px] text-fg-muted">First run: {fullDate(first)}</span>}
      </Panel>
      <Field
        label="Name"
        optional={!trigger}
        error={errors.name}
        hint={
          trigger
            ? 'Shown in lists and on the chats it starts.'
            : 'Leave it empty to name it after what it does.'
        }
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            type="text"
            value={state.name}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            onChange={(event) => onChange({ ...state, name: event.target.value, nameEdited: true })}
          />
        )}
      </Field>
      {trigger && (
        <Field label="Description" optional hint="A note for your team about why it exists.">
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={2}
              value={state.description}
              aria-describedby={describedBy}
              onChange={(event) => onChange({ ...state, description: event.target.value })}
            />
          )}
        </Field>
      )}
      {trigger && (
        <Disclosure
          title="Advanced options"
          hint="Overlapping runs, chat type and machine"
          defaultOpen={Boolean(errors.maxConcurrent || errors.resources)}
        >
          {/* Every trigger kind honours it at admission (schedule, GitHub, webhook, incident). */}
          <CheckRow
            label="Skip a run if the last one is still going"
            hint="Recommended. Otherwise runs can pile up."
            checked={state.trigger.skipIfRunning}
            onChange={(skipIfRunning) => set({ skipIfRunning })}
          />
          <Field
            label="Most runs at once"
            error={errors.maxConcurrent}
            hint={state.trigger.skipIfRunning ? 'Used only when runs may overlap.' : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                max={DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT}
                className={`${INPUT_CLASS} sm:max-w-40`}
                value={
                  Number.isFinite(state.trigger.maxConcurrent) ? state.trigger.maxConcurrent : ''
                }
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(event) => set({ maxConcurrent: event.target.valueAsNumber })}
              />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-fg-primary">Chat type</span>
            <ChoiceCards
              label="Chat type"
              value={state.trigger.taskMode}
              onChange={(taskMode) => set({ taskMode })}
              options={[
                {
                  id: 'task',
                  title: 'Task: finishes on its own',
                  text: 'Best for reports and fixes.',
                },
                {
                  id: 'conversation',
                  title: 'Conversation: stays open',
                  text: 'Best when you want to reply and steer it.',
                },
              ]}
            />
          </div>
          <div className="flex flex-col gap-2 [&_button]:min-h-11 [&_input]:min-h-11 [&_select]:min-h-11">
            <span className="text-sm font-semibold text-fg-primary">Machine</span>
            <ResourceRequirementsInput
              value={state.trigger.resources}
              onChange={(resources) => set({ resources })}
              onClearLegacy={() => set({ legacyVmSize: '' })}
              legacyVmSize={state.trigger.legacyVmSize || null}
              inheritLabel="the agent profile’s default"
              hideDisk
              errors={errors.resources ? validateResourceState(state.trigger.resources) : undefined}
            />
            {errors.resources && (
              <p role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
                {errors.resources}
              </p>
            )}
          </div>
        </Disclosure>
      )}
      {saveError && (
        <p
          role="alert"
          className="m-0 rounded-xl border border-danger/35 bg-danger-tint p-4 text-sm text-fg-primary [overflow-wrap:anywhere]"
        >
          {saveError}
        </p>
      )}
    </div>
  );
}
