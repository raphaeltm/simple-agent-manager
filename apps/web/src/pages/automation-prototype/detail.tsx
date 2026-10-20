import { Button } from '@simple-agent-manager/ui';
import {
  Bot,
  CircleAlert,
  Copy,
  Ellipsis,
  KeyRound,
  MessageSquare,
  Pause,
  Play,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { Page } from './frame';
import { RUNS } from './mock-activity';
import type { Automation } from './mock-data';
import { chatTitle, PROFILES } from './mock-data';
import type { Nav } from './nav';
import {
  actionLabel,
  Disclosure,
  KeyValues,
  KIND_META,
  KindIcon,
  LinkButton,
  OutcomeIcon,
  PageHeader,
  Panel,
  PromptText,
  relative,
  SectionTitle,
  statePill,
  whenLabel,
} from './ui';

const SAMPLE = `{
  "action": "completed",
  "workflow_run": {
    "name": "Deploy Production",
    "conclusion": "success",
    "head_branch": "main"
  }
}`;

function IconButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border-default bg-transparent text-fg-primary hover:bg-surface-hover"
    >
      {children}
    </button>
  );
}

function Actions({ a }: { a: Automation }) {
  const recurring = a.kind !== 'once';
  let buttons: ReactNode;
  if (a.state === 'paused') {
    buttons = (
      <>
        <Button className={a.kind === 'event' ? 'col-span-2' : ''}>
          {a.attention?.primary === 'Raise limit' ? null : <Play size={16} aria-hidden />}
          {a.attention?.primary ?? 'Resume'}
        </Button>
        {a.kind !== 'event' && (
          <Button variant="ghost">
            <RotateCw size={16} aria-hidden /> Run now
          </Button>
        )}
      </>
    );
  } else if (a.state === 'off') {
    buttons = <Button className="col-span-2">Turn on</Button>;
  } else if (a.state === 'finished' && a.attention) {
    buttons = (
      <>
        <Button>
          <MessageSquare size={16} aria-hidden /> Open chat
        </Button>
        <Button variant="ghost">Mark as handled</Button>
      </>
    );
  } else if (!recurring) {
    buttons = (
      <>
        <Button variant="ghost">{a.state === 'retrying' ? 'Send now' : 'Run now'}</Button>
        <Button variant="ghost">Change time</Button>
      </>
    );
  } else {
    buttons = (
      <>
        {a.kind !== 'incident' && (
          <Button variant="ghost">
            <Play size={16} aria-hidden /> Run now
          </Button>
        )}
        <Button variant="ghost" className={a.kind === 'incident' ? 'col-span-2' : ''}>
          <Pause size={16} aria-hidden /> Pause
        </Button>
      </>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px] items-center gap-3 sm:flex sm:flex-wrap [&>button]:min-w-0">
      {buttons}
      <IconButton label="More actions: edit, duplicate, delete">
        <Ellipsis size={18} aria-hidden />
      </IconButton>
    </div>
  );
}

function Attention({ a }: { a: Automation }) {
  if (!a.attention) return null;
  const Icon = a.attention.tone === 'danger' ? TriangleAlert : CircleAlert;
  return (
    <Panel tone={a.attention.tone} className="flex gap-3 p-4">
      <Icon
        size={20}
        aria-hidden
        className="mt-0.5 shrink-0"
        style={{
          color:
            a.attention.tone === 'danger'
              ? 'var(--sam-color-danger-fg)'
              : 'var(--sam-color-warning-fg)',
        }}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-[15px] font-semibold text-fg-primary">{a.attention.title}</p>
        <p className="m-0 text-sm text-fg-muted">{a.attention.body}</p>
      </div>
    </Panel>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">{label}</span>
      <span className="text-[15px] text-fg-primary">{children}</span>
    </div>
  );
}

/** The second fact next to "When": what happens next, in the words that fit this state. */
function SecondFact({ a }: { a: Automation }) {
  if (a.state === 'paused' || a.state === 'off')
    return <Fact label="Next">Not scheduled while {a.state === 'off' ? 'off' : 'paused'}</Fact>;
  if (a.kind === 'once') {
    if (a.state === 'retrying' && a.nextAt)
      return <Fact label="Next try">{`${whenLabel(a.nextAt)} (${relative(a.nextAt)})`}</Fact>;
    if (a.state === 'scheduled' && a.nextAt) return <Fact label="Runs">{relative(a.nextAt)}</Fact>;
    return <Fact label="Result">{a.stateNote ?? 'Done'}</Fact>;
  }
  if (a.nextAt)
    return (
      <Fact label="Next">{`${whenLabel(a.nextAt)}${a.whenNote ? ' your time' : ''} (${relative(a.nextAt)})`}</Fact>
    );
  if (a.lastRun)
    return <Fact label="Last run">{`${whenLabel(a.lastRun.at)} (${relative(a.lastRun.at)})`}</Fact>;
  return <Fact label="Last run">Waiting for the first event</Fact>;
}

function WhenAndWhat({ a }: { a: Automation }) {
  const [full, setFull] = useState(false);
  const { verb, object } = actionLabel(a.action);
  const profile =
    a.action.type === 'start'
      ? PROFILES.find((p) => p.id === (a.action as { profileId: string }).profileId)
      : null;
  return (
    <Panel className="flex flex-col gap-5 p-4 md:p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Fact label="When">
          {a.when}
          {a.whenNote ? <span className="text-fg-muted"> · {a.whenNote}</span> : null}
        </Fact>
        <SecondFact a={a} />
      </div>
      {a.webhook && <Fact label="Only if">{a.webhook.filter}</Fact>}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">Then</span>
        <div className="flex flex-wrap items-center gap-2 text-[15px] text-fg-primary">
          {verb}
          <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border-default px-3 text-sm">
            {a.action.type === 'start' ? (
              <Bot size={14} aria-hidden />
            ) : (
              <MessageSquare size={14} aria-hidden />
            )}
            {object}
          </span>
          {profile && <span className="text-[13px] text-fg-muted">{profile.model}</span>}
        </div>
        <blockquote className="m-0 rounded-lg border-0 border-l-2 border-solid border-accent bg-inset px-4 py-3">
          <p
            className={`m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-primary ${full ? '' : 'line-clamp-3'}`}
          >
            <PromptText text={a.action.prompt} />
          </p>
        </blockquote>
        {(a.action.prompt.length > 160 || a.action.prompt.includes('\n')) && (
          <button
            type="button"
            onClick={() => setFull((v) => !v)}
            className="min-h-11 w-fit rounded-md bg-transparent px-2 text-sm font-semibold text-accent"
          >
            {full ? 'Show less' : 'Show the whole prompt'}
          </button>
        )}
      </div>
      {a.personalKey && (
        <p className="m-0 flex items-center gap-2 rounded-lg bg-warning-tint px-3 py-2 text-[13px] text-warning-fg">
          <KeyRound size={14} aria-hidden /> Runs on {a.personalKey}’s personal key, not a shared
          project key.
        </p>
      )}
    </Panel>
  );
}

function ConnectWebhook({ a }: { a: Automation }) {
  if (!a.webhook) return null;
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle
        title="Connect your service"
        hint="Paste these into the service that will call SAM"
      />
      <Panel className="flex flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Webhook URL</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-inset px-3 py-2.5 text-[13px] text-fg-primary">
              https://api.example.test/api/webhooks/ingest
            </code>
            <IconButton label="Copy webhook URL">
              <Copy size={16} aria-hidden />
            </IconButton>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Secret token</span>
          <span className="text-[15px] text-fg-primary">
            Ending in <span className="font-mono">••••{a.webhook.tokenEnd}</span>
          </span>
          <span className="text-[13px] text-fg-muted">
            Send it in the <span className="font-mono text-[12.5px]">Authorization</span> header as{' '}
            <span className="font-mono text-[12.5px]">Bearer &lt;token&gt;</span>. SAM can’t show it
            again; a new token replaces it right away.
          </span>
          <Button variant="ghost" className="mt-1 w-fit">
            <RotateCw size={16} aria-hidden /> Get a new token
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function TryWebhook({ a }: { a: Automation }) {
  const [tested, setTested] = useState(true);
  if (!a.webhook) return null;
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle
        title="Try it with a sample"
        hint="See what would happen, without starting anything"
      />
      <Panel className="flex flex-col gap-3 p-4 md:p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Sample request body</span>
          <textarea
            defaultValue={SAMPLE}
            rows={7}
            className="w-full min-w-0 rounded-md border border-border-default bg-inset px-3 py-2 font-mono text-[13px] text-fg-primary"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => setTested(true)}>
            Check this sample
          </Button>
        </div>
        {tested && (
          <div className="flex gap-3 rounded-lg border border-border-default bg-inset p-3">
            <OutcomeIcon outcome="ignored" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 text-sm font-semibold text-fg-primary">Wouldn’t start a chat</p>
              <p className="m-0 text-[13px] text-fg-muted">
                <span className="font-mono">workflow_run.conclusion</span> is{' '}
                <span className="font-mono">&quot;success&quot;</span>; this automation only runs
                when it is <span className="font-mono">&quot;failure&quot;</span>.
              </p>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function RecentRuns({ a, nav }: { a: Automation; nav: Nav }) {
  const runs = RUNS.filter((r) => r.automationId === a.id).slice(0, 5);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title={a.webhook ? 'Recent deliveries and runs' : 'Recent runs'}
        count={a.runs || undefined}
        action={
          a.runs > runs.length ? (
            <LinkButton onClick={() => nav.history(a.id)}>All</LinkButton>
          ) : undefined
        }
      />
      <Panel className="overflow-hidden">
        {runs.length === 0 ? (
          <p className="m-0 p-4 text-sm text-fg-muted">
            Nothing yet. Runs show up here with what happened and a link to the chat.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex gap-3 border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
              >
                <span className="pt-0.5">
                  <OutcomeIcon outcome={r.outcome} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-fg-primary">{r.text}</span>
                  {r.detail && <span className="text-[13px] text-fg-muted">{r.detail}</span>}
                  <span className="text-xs text-fg-muted">
                    {whenLabel(r.at)}
                    {r.durationMin ? ` · ${r.durationMin} min` : ''}
                  </span>
                </div>
                {r.chatId || r.outcome === 'ok' || r.outcome === 'failed' ? (
                  <Button variant="ghost" size="md" className="self-center">
                    Chat
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Advanced({ a, open }: { a: Automation; open: boolean }) {
  return (
    <Disclosure title="Advanced" hint="Exact schedule, filters, limits and IDs" defaultOpen={open}>
      <div className="flex flex-col gap-5">
        <KeyValues
          rows={a.advanced.map(([k, v]) => [
            k,
            /ID$|Cron|Endpoint|Channel|Subject|Header/.test(k) ? (
              <span className="font-mono text-[12.5px]">{v}</span>
            ) : (
              v
            ),
          ])}
        />
        <div className="flex flex-col gap-1 text-[13px] text-fg-muted">
          <span>
            Created by {a.createdBy} · {relative(a.createdAt)}
          </span>
          <span>Runs so far: {a.runs}</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="ghost">Edit settings</Button>
          <Button variant="ghost">Duplicate</Button>
        </div>
        <div className="flex flex-col gap-2 border-0 border-t border-solid border-border-default pt-4">
          <span className="text-[13px] text-fg-muted">
            Deleting removes it and its run history. Chats it started stay.
          </span>
          <button
            type="button"
            className="min-h-11 w-fit rounded-md border border-[rgba(239,68,68,0.45)] bg-transparent px-4 text-sm font-semibold text-danger-fg hover:bg-danger-tint"
          >
            Delete automation…
          </button>
        </div>
      </div>
    </Disclosure>
  );
}

export function Detail({
  a,
  nav,
  advancedOpen,
}: {
  a: Automation;
  nav: Nav;
  advancedOpen: boolean;
}) {
  const isMobile = useIsMobile();
  const meta = KIND_META[a.kind];
  const header = (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={{ label: 'Automation', onClick: nav.overview }}
        title={
          <span className="flex items-start gap-3">
            <KindIcon kind={a.kind} size="lg" />
            <span className="min-w-0">{a.name}</span>
          </span>
        }
      />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          {statePill(a, { always: true })}
          <span>{meta.label}</span>
        </div>
        {a.stateNote && <p className="m-0 text-sm text-fg-muted">{a.stateNote}</p>}
      </div>
      <Actions a={a} />
    </div>
  );
  if (isMobile) {
    return (
      <Page>
        {header}
        <Attention a={a} />
        <WhenAndWhat a={a} />
        <ConnectWebhook a={a} />
        <TryWebhook a={a} />
        <RecentRuns a={a} nav={nav} />
        <Advanced a={a} open={advancedOpen} />
      </Page>
    );
  }
  return (
    <Page wide>
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          <Attention a={a} />
          <WhenAndWhat a={a} />
          <RecentRuns a={a} nav={nav} />
          <TryWebhook a={a} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ConnectWebhook a={a} />
          <Advanced a={a} open={advancedOpen} />
          <p className="m-0 text-[13px] text-fg-muted">
            Started by this automation: {a.runs} chats. Each run is an ordinary chat — open it to
            reply, stop it, or fork it.{' '}
            {a.action.type === 'message' ? `Messages go to “${chatTitle(a.action.chatId)}”.` : ''}
          </p>
        </div>
      </div>
    </Page>
  );
}
