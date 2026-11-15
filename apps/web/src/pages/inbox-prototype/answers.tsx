/**
 * PROTOTYPE ONLY — the answer controls for each kind, built from the production components
 * where one exists (AttentionAnswerControls, AcpPermissionCard, SecretRequestForm, and the
 * ApprovalItem decision buttons). Their API calls are answered by mock-api.ts.
 */
import { Button } from '@simple-agent-manager/ui';
import { Check, Send } from 'lucide-react';
import { useMemo, useState } from 'react';

import { AttentionAnswerControls } from '../../components/notifications/AttentionAnswerControls';
import { AcpPermissionCard } from '../../components/project-message-view/AcpPermissionCard';
import { SecretRequestForm } from '../../components/project-message-view/tool-cards/SecretRequestForm';
import type { AcpInteractionSnapshotItem } from '../../lib/api/acp-interactions';
import { answeredInteractions, lastAnswers } from './mock-api';
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

function QuestionControls({
  item,
  onAnswered,
}: {
  item: InboxItem;
  onAnswered: (r: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const resolved = () => onAnswered(`Sent “${lastAnswers.get(item.id) ?? ''}” · ${woke(item)}`);
  return (
    <div className="flex flex-col gap-2">
      <AttentionAnswerControls
        key={typing ? 'typing' : 'options'}
        projectId={PROJECT}
        sessionId={`chat-${item.id}`}
        markerId={item.id}
        options={typing ? [] : (item.options ?? [])}
        allowCustom
        onResolved={resolved}
      />
      {item.options?.length ? (
        <button
          type="button"
          onClick={() => setTyping((t) => !t)}
          className="self-start cursor-pointer border-0 bg-transparent p-0 text-[13px] text-accent"
        >
          {typing ? 'Pick an option instead' : 'Type a different answer'}
        </button>
      ) : null}
    </div>
  );
}

function PermissionControls({
  item,
  onAnswered,
}: {
  item: InboxItem;
  onAnswered: (r: string) => void;
}) {
  const interaction = useMemo<AcpInteractionSnapshotItem>(() => {
    const now = Date.now();
    return {
      interactionId: item.id,
      kind: 'permission',
      state: 'pending',
      createdAt: now - item.ageMin * 60_000,
      deadlineAt: now + (item.deadlineMin ?? 5) * 60_000,
    };
  }, [item]);
  return (
    <AcpPermissionCard
      interaction={interaction}
      projectId={PROJECT}
      sessionId={`chat-${item.id}`}
      canAnswer
      onRefresh={async () => {
        if (answeredInteractions.has(item.id))
          onAnswered('Answer delivered · the agent carried on');
      }}
    />
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
  }
}
