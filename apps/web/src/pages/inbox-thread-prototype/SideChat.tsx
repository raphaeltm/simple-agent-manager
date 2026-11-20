/**
 * PROTOTYPE ONLY: an inbox item you can reply to like the chat. Never ship to production.
 *
 * - The ask is the agent's first message, with its answer controls inside it.
 * - Below it, the full chat composer. Sending puts a message in the agent's own chat, pointing
 *   at this item, and the item leaves the inbox until the agent responds or changes the ask.
 * - When the agent responds on the item, the response shows here and carries the answer
 *   controls (there is only ever one copy, on the newest turn that offers them).
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { Bot, FileImage, MessageSquare } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { InboxItemBody } from '../../components/inbox/InboxItemView';
import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import {
  ProjectChatComposer,
  type ProjectChatComposerAttachment,
} from '../../components/project-chat/ProjectChatComposer';
import { PROTO_NOW, type ThreadEntry } from './mock-data';

function age(at: string): string {
  const minutes = Math.max(1, Math.round((PROTO_NOW - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function AgentAvatar() {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--sam-person-auto)] text-[var(--sam-separator)] ring-2 ring-[var(--sam-separator)]"
    >
      <Bot size={15} strokeWidth={2.2} />
    </span>
  );
}

/** An agent turn: avatar in the gutter, content, then the controls it offers, if any. */
function AgentTurn({
  children,
  offers,
  meta,
}: {
  children: ReactNode;
  offers?: ReactNode;
  meta?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <AgentAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {children}
        {offers && <div className="min-w-0 pt-0.5">{offers}</div>}
        {meta && <span className="text-[11px] text-fg-muted">{meta}</span>}
      </div>
    </div>
  );
}

/** The ask itself, as the opening agent message. */
export function AskTurn({ item, offers }: { item: InboxItem; offers?: ReactNode }) {
  return (
    <AgentTurn offers={offers}>
      <InboxItemBody item={item} context={null} now={PROTO_NOW} stackPosition={null} />
    </AgentTurn>
  );
}

/** What happened on the item after the ask: your chat replies and the agent's responses. */
export function Thread({ entries, offers }: { entries: ThreadEntry[]; offers?: ReactNode }) {
  let lastOffer = -1;
  entries.forEach((entry, index) => {
    if (entry.kind === 'agent' && entry.offers) lastOffer = index;
  });
  return (
    <>
      {entries.map((entry, index) => {
        switch (entry.kind) {
          case 'you':
            return (
              <div key={entry.id} className="flex min-w-0 flex-col items-end gap-1.5">
                <div className="sam-raised max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[15px] break-words text-fg-primary [overflow-wrap:anywhere]">
                  {entry.text}
                </div>
                {entry.attachments?.map((name) => (
                  <span
                    key={name}
                    className="flex max-w-[85%] items-center gap-1.5 rounded-lg border border-[var(--sam-hairline)] px-2.5 py-1.5 text-[13px] text-fg-secondary"
                  >
                    <FileImage size={14} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 truncate">{name}</span>
                  </span>
                ))}
                <span className="flex items-center gap-1 text-[11px] text-fg-muted">
                  <MessageSquare size={11} aria-hidden="true" /> Sent in the agent’s chat ·{' '}
                  {age(entry.at)}
                </span>
              </div>
            );
          case 'agent':
            return (
              <AgentTurn
                key={entry.id}
                offers={index === lastOffer ? offers : undefined}
                meta={`Responded on this item · ${age(entry.at)}`}
              >
                <div className="min-w-0 text-[15px] text-fg-secondary">
                  <RenderedMarkdown content={entry.text} inline />
                </div>
              </AgentTurn>
            );
          case 'activity':
            return (
              <p key={entry.id} className="m-0 pl-9 text-xs text-fg-muted">
                {entry.text}
              </p>
            );
        }
      })}
    </>
  );
}

/** The chat's own composer (attachments, voice, slash commands), pinned under the item. */
export function ItemComposer({
  draft = '',
  attachmentNames = [],
}: {
  draft?: string;
  attachmentNames?: string[];
}) {
  const [value, setValue] = useState(draft);
  const [attachments] = useState<ProjectChatComposerAttachment[]>(() =>
    attachmentNames.map((name, i) => ({
      id: `${name}-${i}`,
      file: new File([new Uint8Array(240_000)], name, { type: 'image/png' }),
      progress: 100,
      status: 'complete',
    }))
  );
  return (
    <ProjectChatComposer
      value={value}
      onChange={setValue}
      onSend={() => undefined}
      sending={false}
      placeholder="Reply to the agent about this…"
      transcribeApiUrl="/api/transcribe"
      attachments={attachments}
      onFilesSelected={() => undefined}
      onRemoveAttachment={() => undefined}
      showShortcutHint={false}
      focusOnMount={false}
    />
  );
}

/** Under an inbox row: the item's latest state at a glance. */
export function ThreadRowHint({
  text,
  unread,
  tone = 'muted',
}: {
  text: string;
  unread?: boolean;
  tone?: 'muted' | 'active';
}) {
  return (
    <div className="-mt-1 flex min-w-0 items-center gap-1.5 pr-3 pb-2.5 pl-14 text-xs">
      {unread && (
        <span
          aria-label="New response"
          className="h-2 w-2 shrink-0 rounded-full bg-[var(--sam-count-active)]"
        />
      )}
      <span
        className={`min-w-0 truncate ${tone === 'active' ? 'font-medium text-fg-primary' : 'text-fg-muted'}`}
      >
        {text}
      </span>
    </div>
  );
}
