/**
 * PROTOTYPE ONLY — the pinned answer controls for each kind. AttentionAnswerControls and
 * SecretRequestForm run unmodified; permission and approval pin only their decision buttons
 * (the production cards bundle a header and description with them). API calls are answered
 * by mock-api.ts.
 */
import { Button } from '@simple-agent-manager/ui';
import { Check, PencilLine, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { AttentionAnswerControls } from '../../components/notifications/AttentionAnswerControls';
import { SecretRequestForm } from '../../components/project-message-view/tool-cards/SecretRequestForm';
import { resolveAttentionAnswer } from '../../lib/api';
import { lastAnswers } from './mock-api';
import { type InboxItem, PEOPLE, secretRequestFor } from './mock-data';

const PROJECT = 'proj-proto';

function woke(item: InboxItem) {
  return item.agent === 'paused' ? 'the agent woke' : 'the agent will pick it up';
}

export function TaskSteps({ item }: { item: InboxItem }) {
  const [done, setDone] = useState(() => item.steps?.map((s) => s.done) ?? []);
  if (!item.steps?.length) return null;
  const readOnly = Boolean(item.team?.claimedBy);
  return (
    <ol className="m-0 flex flex-col p-0">
      {item.steps.map((step, i) => (
        <li
          key={step.text}
          className="list-none border-b border-[var(--sam-hairline)] last:border-b-0"
        >
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5">
            <input
              type="checkbox"
              checked={done[i] ?? false}
              disabled={readOnly}
              onChange={() => setDone((d) => d.map((v, j) => (j === i ? !v : v)))}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--sam-status-success-fg)]"
            />
            <span
              className={`text-[15px] break-words ${done[i] ? 'text-fg-muted line-through' : 'text-fg-primary'}`}
            >
              {step.text}
            </span>
          </label>
        </li>
      ))}
    </ol>
  );
}

/** Above this many options a wrapping button grid is taller than a radio list. */
const RADIO_LIST_ABOVE = 5;

function QuestionControls({
  item,
  onAnswered,
}: {
  item: InboxItem;
  onAnswered: (r: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const options = item.options ?? [];
  const resolved = () => onAnswered(`Sent “${lastAnswers.get(item.id) ?? ''}” · ${woke(item)}`);
  const typeToggle = options.length ? (
    <button
      type="button"
      onClick={() => setTyping((t) => !t)}
      className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--sam-radius-control)] border border-dashed border-[var(--sam-hairline)] bg-transparent px-3 text-[13px] text-fg-secondary"
    >
      <PencilLine size={14} aria-hidden="true" />
      {typing ? 'Pick an option instead' : 'Type a different answer'}
    </button>
  ) : null;
  if (!typing && options.length > RADIO_LIST_ABOVE) {
    return <RadioAnswer item={item} onResolved={resolved} extra={typeToggle} />;
  }
  return (
    // The production controls render their own wrapper; `contents` lets "Type a different
    // answer" sit in the same row as the option buttons instead of under them.
    <div className="flex flex-wrap items-start gap-2 [&>div[role=group]]:contents [&>div[role=group]>div.flex]:contents">
      <AttentionAnswerControls
        key={typing ? 'typing' : 'options'}
        projectId={PROJECT}
        sessionId={`chat-${item.id}`}
        markerId={item.id}
        options={typing ? [] : options}
        allowCustom
        onResolved={resolved}
      />
      {typing ? <div className="w-full">{typeToggle}</div> : typeToggle}
    </div>
  );
}

/** Long option lists: one radio row each, one Send button. Same answer path. */
function RadioAnswer({
  item,
  onResolved,
  extra,
}: {
  item: InboxItem;
  onResolved: () => void;
  extra: ReactNode;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!choice) return;
    setSending(true);
    await resolveAttentionAnswer(PROJECT, `chat-${item.id}`, item.id, choice);
    onResolved();
  };
  return (
    <div className="flex flex-col gap-2">
      {/* The list scrolls on its own so Send stays pinned with it. */}
      <div
        role="radiogroup"
        aria-label="Options"
        className="relative flex max-h-[min(30vh,240px)] flex-col overflow-y-auto"
      >
        {(item.options ?? []).map((option) => (
          <label
            key={option}
            className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[var(--sam-hairline)] py-1.5 last:border-b-0"
          >
            <input
              type="radio"
              name={`opt-${item.id}`}
              checked={choice === option}
              onChange={() => setChoice(option)}
              className="h-5 w-5 shrink-0 accent-[var(--sam-status-success-fg)]"
            />
            <span className="text-[15px] break-words text-fg-primary">{option}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11 flex-1"
          disabled={!choice || sending}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
        {extra}
      </div>
    </div>
  );
}

/**
 * Only the decision buttons are pinned. The production AcpPermissionCard bundles its own
 * title, status, deadline and description with the options; pinned whole it took over half
 * the phone. Production would export its option row (the command is shown in the body).
 */
function PermissionControls({
  item,
  onAnswered,
}: {
  item: InboxItem;
  onAnswered: (r: string) => void;
}) {
  const options = item.permission?.options ?? [];
  const allow = options.find((o) => o.kind === 'allow_once');
  const always = options.find((o) => o.kind === 'allow_always');
  const deny = options.find((o) => o.kind === 'reject_once');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-2">
        {allow && (
          <Button
            className="min-h-11"
            onClick={() => onAnswered('Allowed once · the agent carried on')}
          >
            {allow.name}
          </Button>
        )}
        {deny && (
          <Button
            variant="secondary"
            className="min-h-11"
            onClick={() => onAnswered('Denied · the agent was told')}
          >
            {deny.name}
          </Button>
        )}
      </div>
      {always && (
        <button
          type="button"
          onClick={() => onAnswered('Allowed for this chat · the agent carried on')}
          className="min-h-9 cursor-pointer self-center border-0 bg-transparent text-[13px] text-fg-secondary"
        >
          {always.name}
        </button>
      )}
    </div>
  );
}

/** Review: one primary "Looks good"; anything else is a reply that goes to the chat. */
function ReviewControls({
  item,
  onAnswered,
}: {
  item: InboxItem;
  onAnswered: (r: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <Button className="min-h-11 w-full" onClick={() => onAnswered(`Looks good · ${woke(item)}`)}>
        <Check size={16} aria-hidden="true" /> Looks good
      </Button>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onAnswered(`Reply sent to “${item.chat}” · ${woke(item)}`);
        }}
      >
        <textarea
          aria-label="Reply with changes"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or reply with changes…"
          className="sam-well min-h-11 min-w-0 flex-1 resize-none rounded-[var(--sam-radius-control)] border-0 px-3 py-2.5 text-base text-fg-primary md:text-sm"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={!text.trim()}
          className="min-h-11"
          aria-label="Send reply"
        >
          <Send size={16} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}

/** Controls for the pinned dock. One primary action per kind. */
export function AnswerControls({
  item,
  onAnswered,
}: {
  item: InboxItem;
  onAnswered: (receipt: string) => void;
}) {
  switch (item.kind) {
    case 'question':
      return <QuestionControls item={item} onAnswered={onAnswered} />;
    case 'permission':
      return <PermissionControls item={item} onAnswered={onAnswered} />;
    case 'secret':
      return (
        <SecretRequestForm
          projectId={PROJECT}
          request={secretRequestFor(item)}
          existing={null}
          onResolved={(r) =>
            onAnswered(
              r.request.status === 'declined'
                ? 'Declined · the agent was told'
                : `Saved ${item.secret?.envKey} · ${woke(item)}`
            )
          }
        />
      );
    case 'approval': {
      const irreversible = item.approval?.action.startsWith('delete');
      return (
        <div className="grid grid-cols-2 gap-3">
          <Button
            variant={irreversible ? 'danger' : 'primary'}
            className="min-h-11"
            onClick={() => onAnswered('Approved · the agent is deleting it')}
          >
            Approve
          </Button>
          <Button
            variant="secondary"
            className="min-h-11"
            onClick={() => onAnswered('Denied · the agent was told')}
          >
            Deny
          </Button>
        </div>
      );
    }
    case 'task': {
      if (item.team?.claimedBy) {
        const name = PEOPLE[item.team.claimedBy].name.split(' ')[0];
        return (
          <p className="m-0 text-sm text-fg-muted">
            {name} is on it. It comes back here if {name} hands it back.
          </p>
        );
      }
      if (item.team) {
        return (
          <Button
            className="min-h-11 w-full"
            onClick={() => onAnswered('You took it · the team was told')}
          >
            Take it
          </Button>
        );
      }
      return (
        <Button
          className="min-h-11 w-full"
          onClick={() => onAnswered('Marked done · the agent was told')}
        >
          <Check size={16} aria-hidden="true" /> Mark done
        </Button>
      );
    }
    case 'review':
      return <ReviewControls item={item} onAnswered={onAnswered} />;
    case 'failed':
      return (
        <div className="grid grid-cols-2 gap-3">
          <Button
            className="min-h-11"
            onClick={() =>
              onAnswered(`Started: ${item.title.replace(/^Couldn’t start: /, '')} · Open chat`)
            }
          >
            Retry
          </Button>
          <Button variant="secondary" className="min-h-11">
            Edit, then retry
          </Button>
        </div>
      );
  }
}
