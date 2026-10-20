import { Button } from '@simple-agent-manager/ui';
import { Bot, Check, MessageSquare, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { Page } from './frame';
import type { Kind } from './mock-data';
import { NOW, PROFILES } from './mock-data';
import type { Nav, NewStep } from './nav';
import { Disclosure, KindIcon, Panel } from './ui';

const STEPS: Array<{ id: NewStep; label: string }> = [
  { id: 'when', label: 'Start' },
  { id: 'schedule', label: 'Details' },
  { id: 'do', label: 'What happens' },
  { id: 'review', label: 'Review' },
];

const WHEN_OPTIONS: Array<{ kind: Kind; title: string; text: string; advanced?: boolean }> = [
  {
    kind: 'schedule',
    title: 'On a schedule',
    text: 'Every day, on weekdays, weekly, or every few hours.',
  },
  {
    kind: 'once',
    title: 'Once, at a time you pick',
    text: 'Start work later, or remind a chat about something.',
  },
  {
    kind: 'github',
    title: 'When something happens on GitHub',
    text: 'New issues, comments, pull requests or pushes.',
  },
  {
    kind: 'webhook',
    title: 'When another service calls SAM',
    text: 'Your CI, monitoring or app sends a request.',
  },
  {
    kind: 'event',
    title: 'When SAM sees an event',
    text: 'CI checks finish, a task fails, an agent posts in a channel.',
    advanced: true,
  },
];

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tzCity = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz;
const nextWeekdays = (() => {
  const out: number[] = [];
  const d = new Date(NOW);
  d.setHours(9, 0, 0, 0);
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(d.getTime());
  }
  return out;
})();
const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function Stepper({ step }: { step: NewStep }) {
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium text-fg-muted">
        Step {index + 1} of {STEPS.length} · {STEPS[index]?.label}
      </span>
      <div className="grid grid-cols-4 gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s.id}
            className={`h-1.5 rounded-full ${i <= index ? 'bg-accent' : 'bg-[rgba(159,183,174,0.18)]'}`}
          />
        ))}
      </div>
    </div>
  );
}

function Choice({
  selected,
  icon,
  title,
  text,
  badge,
}: {
  selected?: boolean;
  icon: ReactNode;
  title: string;
  text: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
        selected
          ? 'border-accent bg-[var(--sam-color-accent-primary-tint)]'
          : 'border-border-default glass-surface hover:bg-surface-hover'
      }`}
      style={{ minHeight: 72 }}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-fg-primary">
          {title}
          {badge && (
            <span className="rounded-full bg-[rgba(159,183,174,0.14)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              {badge}
            </span>
          )}
        </span>
        <span className="text-[13px] text-fg-muted">{text}</span>
      </span>
      <span
        className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-accent bg-accent text-fg-on-accent' : 'border-border-default'}`}
        aria-hidden
      >
        {selected && <Check size={12} />}
      </span>
    </button>
  );
}

function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold text-fg-primary">{children}</span>
      {hint && <span className="text-[13px] text-fg-muted">{hint}</span>}
    </span>
  );
}

const fieldClass =
  'w-full min-w-0 min-h-11 rounded-md border border-border-default bg-inset px-3 text-[15px] text-fg-primary';

function StepWhen() {
  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label="What should start it?">
      {WHEN_OPTIONS.map((o) => (
        <Choice
          key={o.kind}
          selected={o.kind === 'schedule'}
          icon={<KindIcon kind={o.kind} />}
          title={o.title}
          text={o.text}
          badge={o.advanced ? 'Advanced' : undefined}
        />
      ))}
    </div>
  );
}

function StepSchedule() {
  const presets = ['Every day', 'Weekdays', 'Weekly', 'Every few hours', 'Custom'];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Label>How often?</Label>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How often">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === 'Weekdays'}
              className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${
                p === 'Weekdays'
                  ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                  : 'border-border-default bg-transparent text-fg-muted'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
        <label className="flex flex-col gap-2">
          <Label>At</Label>
          <input type="time" defaultValue="09:00" className={fieldClass} />
        </label>
        <label className="flex flex-col gap-2">
          <Label>Time zone</Label>
          <select defaultValue="local" className={fieldClass}>
            <option value="local">Your time · {tzCity}</option>
            <option value="utc">UTC</option>
            <option value="search">Search all time zones…</option>
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-inset p-4">
        <span className="text-[13px] font-medium text-fg-muted">Next runs</span>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {nextWeekdays.map((t) => (
            <li key={t} className="flex items-center gap-2 text-[15px] text-fg-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              {longDate.format(t)}
            </li>
          ))}
        </ul>
        <span className="text-xs text-fg-muted">
          Prefer cron? Pick “Custom” and type an expression like 0 9 * * 1-5.
        </span>
      </div>
    </div>
  );
}

function StepDo() {
  return (
    <div className="flex flex-col gap-6">
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        role="radiogroup"
        aria-label="What should happen?"
      >
        <Choice
          selected
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--sam-color-accent-primary-tint)] text-accent">
              <Bot size={18} aria-hidden />
            </span>
          }
          title="Start a new chat"
          text="An agent picks up the work. You can read or reply any time."
        />
        <Choice
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-info-tint text-info-fg">
              <MessageSquare size={18} aria-hidden />
            </span>
          }
          title="Message a chat"
          text="Send a note to a chat that already exists, even if it’s asleep."
        />
      </div>
      <label className="flex flex-col gap-2">
        <Label hint="Decides the model, tools and machine.">Agent</Label>
        <select defaultValue="p-codex" className={fieldClass}>
          {PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.model}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2">
        <Label hint="Write it like a message to the agent.">What should it do?</Label>
        <textarea
          rows={5}
          defaultValue="Summarize the open pull requests: what's ready to merge, what's blocked, and what needs a review from me. Keep it short."
          className={`${fieldClass} py-2.5 leading-relaxed`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost">
          <Plus size={16} aria-hidden /> Add a detail from the run
        </Button>
        <span className="text-[13px] text-fg-muted">e.g. the date, or the GitHub issue title</span>
      </div>
    </div>
  );
}

function StepReview() {
  return (
    <div className="flex flex-col gap-6">
      <Panel className="flex flex-col gap-3 p-4 md:p-5">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          This automation will
        </span>
        <p className="m-0 text-[17px] leading-relaxed text-fg-primary">
          Every <strong>weekday at 9:00 AM</strong> ({tzCity} time),{' '}
          <strong>start a new chat</strong> with <strong>Codex 5.5 High Chat</strong> and ask it to
          summarize the open pull requests.
        </p>
        <span className="text-[13px] text-fg-muted">
          First run: {longDate.format(nextWeekdays[0])}
        </span>
      </Panel>
      <label className="flex flex-col gap-2">
        <Label hint="Suggested from what it does. Change it if you like.">Name</Label>
        <input type="text" defaultValue="Morning PR summary" className={fieldClass} />
      </label>
      <Disclosure
        title="Advanced options"
        hint="Overlaps, limits, machine and chat type"
        defaultOpen
      >
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-2">
            <Label>If the last run is still going</Label>
            <select defaultValue="skip" className={fieldClass}>
              <option value="skip">Skip this run (recommended)</option>
              <option value="run">Run anyway, up to 2 at once</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <Label>Pause it after</Label>
            <select defaultValue="3" className={fieldClass}>
              <option value="3">3 failed runs in a row (recommended)</option>
              <option value="5">5 failed runs in a row</option>
              <option value="never">Never pause on its own</option>
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <Label>Machine</Label>
            <select defaultValue="profile" className={fieldClass}>
              <option value="profile">Use the agent’s default</option>
              <option value="2">2 vCPU · 4 GB</option>
              <option value="4">4 vCPU · 8 GB</option>
            </select>
          </label>
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Chat type">
            <Label>Chat type</Label>
            <Choice
              selected
              icon={<span className="sr-only">Task</span>}
              title="Task — finishes on its own"
              text="Best for reports and fixes. The chat ends when the work is done."
            />
            <Choice
              icon={<span className="sr-only">Conversation</span>}
              title="Conversation — stays open"
              text="Best when you want to reply and steer it."
            />
          </div>
        </div>
      </Disclosure>
    </div>
  );
}

const STEP_TITLES: Record<NewStep, { title: string; hint: string }> = {
  when: { title: 'What should start it?', hint: 'Pick one. You can change the details next.' },
  schedule: {
    title: 'When should it run?',
    hint: 'Times use your time zone unless you pick another.',
  },
  do: { title: 'What should happen?', hint: 'Every run is an ordinary chat you can open later.' },
  review: { title: 'Check and create', hint: 'Read it as a sentence. If it sounds right, it is.' },
};

export function NewAutomation({ step, nav }: { step: NewStep; nav: Nav }) {
  const isMobile = useIsMobile();
  const index = STEPS.findIndex((s) => s.id === step);
  const next = STEPS[index + 1]?.id;
  const prev = STEPS[index - 1]?.id;
  const body =
    step === 'when' ? (
      <StepWhen />
    ) : step === 'schedule' ? (
      <StepSchedule />
    ) : step === 'do' ? (
      <StepDo />
    ) : (
      <StepReview />
    );
  const footer = (
    <div
      className={
        isMobile
          ? 'sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-0 border-t border-solid border-border-default px-4 py-3 glass-chrome'
          : 'flex items-center justify-between gap-3 border-0 border-t border-solid border-border-default pt-5'
      }
    >
      <Button variant="ghost" onClick={() => (prev ? nav.create(prev) : nav.overview())}>
        {prev ? 'Back' : 'Cancel'}
      </Button>
      <Button onClick={() => (next ? nav.create(next) : nav.overview())}>
        {next ? 'Continue' : 'Create automation'}
      </Button>
    </div>
  );
  const heading = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="m-0 text-[22px] font-bold text-fg-primary">New automation</h1>
        <button
          type="button"
          aria-label="Close"
          onClick={nav.overview}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary"
        >
          <X size={20} aria-hidden />
        </button>
      </div>
      <Stepper step={step} />
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[18px] font-semibold text-fg-primary">{STEP_TITLES[step].title}</h2>
        <p className="m-0 text-sm text-fg-muted">{STEP_TITLES[step].hint}</p>
      </div>
    </div>
  );
  if (isMobile) {
    return (
      <Page>
        {heading}
        {body}
        {footer}
      </Page>
    );
  }
  return (
    <Page wide>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-10">
        <div className="flex min-w-0 flex-col gap-6">
          {heading}
          {body}
          {footer}
        </div>
        <aside className="sticky top-8 flex flex-col gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
            Preview
          </span>
          <Panel className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-3">
              <KindIcon kind="schedule" />
              <span className="text-[15px] font-semibold text-fg-primary">Morning PR summary</span>
            </div>
            <p className="m-0 text-sm leading-relaxed text-fg-muted">
              {index === 0
                ? 'Runs on a schedule. Pick the days and time next.'
                : `Every weekday at 9:00 AM (${tzCity}) → start a new chat with Codex 5.5 High Chat.`}
            </p>
            {index > 0 && (
              <span className="text-[13px] text-fg-muted">
                Next: {longDate.format(nextWeekdays[0])}
              </span>
            )}
          </Panel>
          <p className="m-0 text-[13px] text-fg-muted">
            Nothing is created until you press “Create automation”.
          </p>
        </aside>
      </div>
    </Page>
  );
}
