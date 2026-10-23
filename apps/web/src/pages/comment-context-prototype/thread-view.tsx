/**
 * The comment thread pieces every direction shares: who and why, the entries, the reply box.
 */
import { Avatar, Button } from '@simple-agent-manager/ui';
import { Bot, Check } from 'lucide-react';
import { useCallback, useState } from 'react';

import { ME } from '../comments-inbox-prototype/mock-data';
import { relative } from '../comments-inbox-prototype/model';
import { ReplyBox, RichText } from '../comments-inbox-prototype/ui';
import type { ChatSession, ContextThread } from './mock-session';

export function ThreadReason({ thread }: { thread: ContextThread }) {
  return (
    <p className="m-0 text-sm leading-snug text-fg-primary">
      <span className="font-semibold">{thread.reason.actor}</span> {thread.reason.verb}
    </p>
  );
}

export function ThreadEntries({
  thread,
  dense = false,
}: {
  thread: ContextThread;
  dense?: boolean;
}) {
  return (
    <ol className={`m-0 flex list-none flex-col p-0 ${dense ? 'gap-3' : 'gap-4'}`}>
      {thread.entries.map((entry) => (
        <li key={entry.id} className="flex min-w-0 gap-2.5">
          <Avatar
            name={entry.author.name}
            tone={entry.author.kind === 'agent' ? 'agent' : 'human'}
            size={dense ? 'md' : 'lg'}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-fg-primary">{entry.author.name}</span>
              <span className="text-xs tabular-nums text-fg-muted">{relative(entry.at)}</span>
              {entry.sentToAgent && (
                <span className="inline-flex items-center gap-1 text-xs text-info-fg">
                  <Bot size={12} aria-hidden /> Sent to agent
                </span>
              )}
            </div>
            <RichText text={entry.body} className="mt-0.5" />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ResolveButton({ resolved, onToggle }: { resolved: boolean; onToggle: () => void }) {
  return (
    <Button size="sm" variant={resolved ? 'ghost' : 'secondary'} onClick={onToggle}>
      <Check size={15} aria-hidden /> {resolved ? 'Resolved' : 'Resolve'}
    </Button>
  );
}

export function ThreadReply({
  session,
  thread,
  onReply,
  focusOnMount,
}: {
  session: ChatSession;
  thread: ContextThread;
  onReply: (body: string, sendToAgent: boolean) => void;
  focusOnMount?: boolean;
}) {
  const last = thread.entries[thread.entries.length - 1];
  const placeholder =
    !last || last.author.id === ME.id
      ? 'Add to this thread…'
      : last.author.kind === 'agent'
        ? 'Reply to the agent…'
        : `Reply to ${last.author.name.split(' ')[0]}…`;
  return (
    <ReplyBox
      key={thread.id}
      focusOnMount={focusOnMount}
      canSendToAgent={session.youControl && thread.status !== 'resolved'}
      readerHint={
        session.youControl ? undefined : `Only ${session.ownerName} can send this to the agent.`
      }
      placeholder={placeholder}
      onSubmit={onReply}
    />
  );
}

/** Threads with in-memory replies and resolve state, so the prototype is clickable. */
export function useThreadState(initial: ContextThread[]) {
  const [threads, setThreads] = useState(initial);
  const reply = useCallback((threadId: string, body: string, sendToAgent: boolean) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              status: sendToAgent ? 'sent' : thread.status,
              needsYou: false,
              reason: { actor: 'You', verb: sendToAgent ? 'sent this to the agent' : 'replied' },
              entries: [
                ...thread.entries,
                {
                  id: `r-${Date.now()}`,
                  author: ME,
                  body,
                  at: Date.now(),
                  sentToAgent: sendToAgent,
                },
              ],
            }
          : thread
      )
    );
  }, []);
  const toggleResolved = useCallback((threadId: string) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              status: thread.status === 'resolved' ? 'open' : 'resolved',
              needsYou: false,
            }
          : thread
      )
    );
  }, []);
  return { threads, reply, toggleResolved };
}
