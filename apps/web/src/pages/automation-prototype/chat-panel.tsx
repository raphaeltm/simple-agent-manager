import { Button } from '@simple-agent-manager/ui';
import { AlarmClock, Hourglass, Paperclip, Radio, Send, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { WAITS } from './mock-activity';
import { automationFor } from './mock-data';
import type { Nav } from './nav';
import { LinkButton, Pill, whenLabel } from './ui';

/** A plain stand-in for the chat page behind the panel. */
export function ChatBackdrop() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-0 border-b border-solid border-border-default px-5 py-4">
        <span className="text-[17px] font-semibold text-fg-primary">PR #2387 release shepherd</span>
        <Pill tone="info">Sleeping</Pill>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <p className="m-0 ml-auto max-w-[80%] rounded-xl bg-[var(--sam-color-accent-primary-tint)] px-4 py-3 text-sm text-fg-primary">
          Ship PR #2387 once CI is green, then confirm the production deploy.
        </p>
        <p className="m-0 max-w-[80%] rounded-xl bg-inset px-4 py-3 text-sm text-fg-primary">
          CI is still running. I’ll wait for the checks on the PR head and continue when they
          finish.
        </p>
      </div>
      <div className="flex items-center gap-3 border-0 border-t border-solid border-border-default p-4 text-fg-muted">
        <Paperclip size={18} aria-hidden />
        <span className="flex-1 rounded-lg border border-border-default px-3 py-2.5 text-sm">
          Send a message to wake the agent…
        </span>
        <Send size={18} aria-hidden />
      </div>
    </div>
  );
}

function Row({
  icon,
  title,
  sub,
  action,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 border-0 border-b border-solid border-border-default py-3 last:border-b-0">
      <span className="mt-0.5 shrink-0 text-fg-muted">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold leading-snug text-fg-primary">{title}</span>
        <span className="text-[13px] text-fg-muted">{sub}</span>
      </span>
      {action}
    </li>
  );
}

export function ChatAutomationPanel({ nav }: { nav: Nav }) {
  const isMobile = useIsMobile();
  const waits = WAITS.filter(
    (w) => w.chatId === 'chat-release' && w.state === 'waiting' && !w.system
  );
  const once = automationFor('release-check');
  const watch = automationFor('ci-red');
  const panel = (
    <div
      role="dialog"
      aria-label="Automation for this chat"
      className={`glass-modal glass-panel-container glass-composited flex flex-col overflow-hidden ${
        isMobile
          ? 'fixed inset-0 z-50 bg-[var(--sam-color-bg-canvas)]'
          : 'fixed inset-y-0 right-0 z-50 w-[440px] rounded-l-[20px] border-y-0 border-r-0'
      }`}
    >
      <div className="flex min-h-14 items-center justify-between gap-3 border-0 border-b border-solid border-border-default px-4">
        <span className="flex flex-col">
          <span className="text-[15px] font-semibold text-fg-primary">
            Automation for this chat
          </span>
          <span className="text-xs text-fg-muted">PR #2387 release shepherd</span>
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={nav.overview}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-transparent text-fg-muted"
        >
          <X size={20} aria-hidden />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
        <section className="flex flex-col gap-1">
          <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">
            This chat is waiting for
          </h3>
          <ul className="m-0 list-none p-0">
            {waits.map((w) => (
              <Row
                key={w.id}
                icon={<Hourglass size={18} aria-hidden />}
                title={w.waitingFor.charAt(0).toUpperCase() + w.waitingFor.slice(1)}
                sub={`Until ${whenLabel(w.until)} · SAM wakes the chat when it happens`}
              />
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">
            Coming up for this chat
          </h3>
          <ul className="m-0 list-none p-0">
            <Row
              icon={<AlarmClock size={18} aria-hidden />}
              title={once.name}
              sub={`${once.nextAt ? whenLabel(once.nextAt) : 'Soon'} · sends a message here`}
              action={
                <Button variant="ghost" size="md" className="shrink-0">
                  Change
                </Button>
              }
            />
            <Row
              icon={<Radio size={18} aria-hidden />}
              title={watch.name}
              sub="Paused · used all 20 of its runs"
              action={
                <Button
                  variant="ghost"
                  size="md"
                  className="shrink-0"
                  onClick={() => nav.detail(watch.id)}
                >
                  Open
                </Button>
              }
            />
          </ul>
        </section>
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">
              Remind this chat later
            </h3>
            <span className="text-[13px] text-fg-muted">
              SAM sends your note here at that time, even if the chat is asleep.
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost">In 1 hour</Button>
            <Button variant="ghost">Tomorrow 9:00 AM</Button>
            <Button variant="ghost">Pick a time…</Button>
          </div>
        </section>
      </div>
      <div className="flex justify-end border-0 border-t border-solid border-border-default px-2 py-1">
        <LinkButton onClick={nav.overview}>All automation</LinkButton>
      </div>
    </div>
  );
  return (
    <>
      {!isMobile && <div className="fixed inset-0 z-40 glass-backdrop-dim" aria-hidden />}
      {panel}
    </>
  );
}
