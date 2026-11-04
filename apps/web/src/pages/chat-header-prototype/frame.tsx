import { paneClassName } from '@simple-agent-manager/ui';
import {
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  Copy,
  Flag,
  FolderOpen,
  GitBranch,
  Info,
  Link2,
  Menu,
  MessageSquare,
  Mic,
  Network,
  PanelRight,
  Paperclip,
  SendHorizontal,
  Activity,
  Volume2,
  CircleCheck,
} from 'lucide-react';
import type { ReactNode, UIEventHandler } from 'react';

import type { MockMessage } from './mock-data';

/** Mock of the mobile app bar above the chat (not part of either proposal). */
export function MockAppBar() {
  return (
    <div className={`${paneClassName('slab')} flex h-14 shrink-0 items-center gap-3 px-3`}>
      <Menu size={20} className="text-fg-muted" aria-hidden="true" />
      <span className="flex-1 text-[17px] font-semibold text-fg-primary">SAM</span>
      <MessageSquare size={18} className="text-fg-muted" aria-hidden="true" />
      <Bell size={18} className="text-fg-muted" aria-hidden="true" />
      <PanelRight size={18} className="text-fg-muted" aria-hidden="true" />
    </div>
  );
}

const RAIL_ICONS = [FolderOpen, GitBranch, Clock, Link2, Activity, Network, Flag, CircleCheck, Info];

function MockRail() {
  return (
    <div className="flex w-[46px] shrink-0 flex-col items-center gap-4 border-l border-[var(--sam-hairline)] py-3 text-fg-muted">
      <ChevronLeft size={16} aria-hidden="true" />
      {RAIL_ICONS.map((Icon, i) => (
        <Icon key={i} size={18} aria-hidden="true" />
      ))}
    </div>
  );
}

function MessageRow({ message }: { message: MockMessage }) {
  if (message.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-[var(--sam-chip-bg)] px-3.5 py-2.5 text-[14.5px] leading-relaxed text-fg-primary">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.kind === 'tools') {
    return (
      <div className="flex h-10 items-center gap-2 rounded-xl border border-[var(--sam-hairline)] px-3 text-[13px] text-fg-primary">
        <Check size={15} className="text-[var(--sam-status-success-fg)]" aria-hidden="true" />
        <span className="flex-1">{message.count} tool calls</span>
        <ChevronDown size={15} className="text-fg-muted" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="text-[14.5px] leading-relaxed text-fg-primary">
      <p className="m-0">{message.text}</p>
      <div className="mt-1.5 flex gap-4 text-fg-muted">
        <Info size={14} aria-hidden="true" />
        <Volume2 size={14} aria-hidden="true" />
        <Copy size={14} aria-hidden="true" />
      </div>
    </div>
  );
}

export function MockConversation({
  messages,
  onScroll,
  scrollRef,
}: {
  messages: MockMessage[];
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className={`${paneClassName('quiet')} flex min-h-0 flex-1 overflow-hidden`}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="proto-conversation"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-4"
      >
        {messages.map((message, i) => (
          <MessageRow key={i} message={message} />
        ))}
      </div>
      <MockRail />
    </div>
  );
}

export function MockComposer({ footer }: { footer?: ReactNode }) {
  return (
    <div className={`${paneClassName('slab')} shrink-0 space-y-2 p-2.5`}>
      {footer}
      <div className="flex items-center gap-2">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--sam-chip-bg)] text-fg-muted">
          <Paperclip size={17} aria-hidden="true" />
        </span>
        <span className="flex h-10 flex-1 items-center rounded-xl border border-[var(--sam-hairline)] px-3 text-sm text-fg-muted">
          Agent is working...
        </span>
        <Mic size={18} className="text-fg-muted" aria-hidden="true" />
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--sam-status-success-bg)] text-[var(--sam-status-success-fg)]">
          <SendHorizontal size={17} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}
