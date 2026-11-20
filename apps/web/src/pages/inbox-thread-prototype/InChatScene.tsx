/**
 * PROTOTYPE ONLY: an inbox reply as it lands in the agent's own chat. It is an ordinary chat
 * message from the person; a small chip says which inbox item it is about and opens it. The
 * agent then decides what to do (here: respond on the item). Never ship to production.
 */
import { Pane } from '@simple-agent-manager/ui';
import { Bot, FileImage, Inbox, MessageCircleQuestion, Wrench } from 'lucide-react';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import { QUESTION, QUESTION_REPLY_TEXT } from './mock-data';

function AgentMessage({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-[15px] text-fg-secondary">
      <RenderedMarkdown content={text} inline />
    </div>
  );
}

function ToolLine({ text }: { text: string }) {
  return (
    <p className="m-0 flex items-center gap-1.5 text-xs text-fg-muted">
      <Wrench size={12} aria-hidden="true" /> {text}
    </p>
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
              <p className="m-0 text-xs text-fg-muted">Asked you in the inbox · 25m ago</p>
              <p className="m-0 text-sm font-medium break-words text-fg-primary">
                {QUESTION.title}
              </p>
            </div>
          </div>
          <ToolLine text="Ran tests · 2 files changed" />

          {/* The inbox reply: an ordinary message from the person, with a pointer chip. */}
          <div className="flex min-w-0 flex-col items-end gap-1.5">
            <button
              type="button"
              className="flex min-h-9 max-w-[85%] cursor-pointer items-center gap-1.5 rounded-full border border-[var(--sam-hairline)] bg-transparent px-3 text-[12px] text-fg-secondary"
            >
              <Inbox size={13} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">Re: {QUESTION.title}</span>
            </button>
            <div className="sam-raised max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[15px] break-words text-fg-primary">
              {QUESTION_REPLY_TEXT}
            </div>
            <span className="flex max-w-[85%] items-center gap-1.5 rounded-lg border border-[var(--sam-hairline)] px-2.5 py-1.5 text-[13px] text-fg-secondary">
              <FileImage size={14} aria-hidden="true" className="shrink-0" />
              retry-graph-week-46.png
            </span>
            <span className="text-[11px] text-fg-muted">You · from the inbox · 12m</span>
          </div>

          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--sam-person-auto)] text-[var(--sam-separator)]"
            >
              <Bot size={15} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <ToolLine text="Read retry-graph-week-46.png · read 3 files" />
              <AgentMessage text="Good question. It changes the answer slightly, so I've responded on the inbox item and I'm waiting there for your decision." />
              <ToolLine text="Responded on the inbox item" />
            </div>
          </div>
        </div>
      </Pane>
    </>
  );
}
