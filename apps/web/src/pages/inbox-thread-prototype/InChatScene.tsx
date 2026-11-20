/**
 * PROTOTYPE ONLY: how an inbox side-chat shows up in the agent's own chat. The exchange happened
 * in the inbox, so the chat shows it folded into one card at the point it happened, instead of
 * splicing loose messages into the agent's main thread. Never ship to production.
 */
import { Pane } from '@simple-agent-manager/ui';
import { ChevronDown, Inbox, MessageCircleQuestion } from 'lucide-react';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import { QUESTION_THREAD } from './mock-data';
import { Thread } from './SideChat';

function AgentMessage({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-[15px] text-fg-secondary">
      <RenderedMarkdown content={text} inline />
    </div>
  );
}

export function InChatScene() {
  return (
    <>
      <Pane as="header" variant="slab" className="flex shrink-0 flex-col gap-0.5 px-4 py-3">
        <span className="text-xs text-fg-muted">SAM · Chat</span>
        <span className="text-[15px] font-semibold text-fg-primary">
          Workspace deletion retries
        </span>
      </Pane>
      <Pane
        variant="quiet"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-4 px-4 py-4">
          <AgentMessage text="Retries are now capped and logged per attempt. One open design point before I push the rest." />
          <div className="sam-well flex min-w-0 items-start gap-2.5 rounded-xl px-3 py-2.5">
            <MessageCircleQuestion
              size={16}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-warning-fg"
            />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-xs text-fg-muted">Asked you in the inbox · paused on this</p>
              <p className="m-0 text-sm font-medium break-words text-fg-primary">
                Should the retry cap apply per node or per project?
              </p>
            </div>
          </div>

          {/* The side-chat, folded: one card at the point it happened, expandable. */}
          <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--sam-hairline)] px-3 py-3">
            <button
              type="button"
              aria-expanded="true"
              className="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
            >
              <Inbox size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 text-sm text-fg-primary">
                <span className="font-medium">Side-chat from your inbox</span>
                <span className="text-fg-muted"> · 3 messages · 12m ago</span>
              </span>
              <ChevronDown
                size={16}
                aria-hidden="true"
                className="shrink-0 rotate-180 text-fg-muted"
              />
            </button>
            <Thread entries={QUESTION_THREAD} />
          </div>

          <p className="m-0 text-sm text-[var(--sam-status-success-fg)]">
            You answered: Per project
          </p>
          <AgentMessage text="Switching the cap to per project. Existing nodes keep their counts, as discussed. Pushing now." />
        </div>
      </Pane>
    </>
  );
}
