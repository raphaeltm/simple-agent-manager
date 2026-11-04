/**
 * PROTOTYPE ONLY — chat notification elements ported to SAM Glass, shown in a mock chat column.
 * Route: /prototype/chat-notices?scene=<name>&theme=light. Do not merge to main.
 */
import { Pane, paneClassName } from '@simple-agent-manager/ui';
import {
  CloudOff,
  KeyRound,
  Link2Off,
  RotateCw,
  Server,
  WifiOff,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import {
  AccentButton,
  FooterNoticeRow,
  GhostButton,
  MetaChip,
  NoticeSlab,
  RaisedButton,
  StageTrack,
  StatusCapsule,
} from './notices';

const STAGES = ['Provisioning VM', 'Cloning repository', 'Installing dependencies', 'Starting agent'];
const TITLE = 'Investigate slow chat session loading and reconnection issues';
const BRANCH = 'sam/sometimes-switch-different-chat-ys33n5';

const SHIMMER_CSS = `
@keyframes chat-notice-shimmer { from { background-position: -120% 0 } to { background-position: 220% 0 } }
.chat-notice-shimmer { background-size: 200% 100%; }
.chat-notice-shimmer::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.55), transparent);
  background-size: 50% 100%; background-repeat: no-repeat; animation: chat-notice-shimmer 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .chat-notice-shimmer::after { animation: none; } }
`;

function HeaderSlab({ state = 'Working' }: { state?: string }) {
  return (
    <Pane variant="slab" as="header" className="shrink-0 px-5 py-3.5">
      <div className="flex items-center gap-2 text-[12px] text-fg-muted">
        <span>SAM</span>
        <span>/</span>
        <span>Chat</span>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 text-[20px] font-bold leading-tight text-fg-primary">
          {TITLE}
        </h1>
        <MetaChip mono={false}>{state}</MetaChip>
      </div>
    </Pane>
  );
}

function Transcript() {
  return (
    <div className="flex flex-col gap-5 px-5 pb-6 pt-16 md:px-8">
      <div className="ml-auto max-w-[80%] rounded-[18px] px-4 py-2.5 text-[14px] text-fg-primary sam-raised">
        Sometimes when I switch to a different chat the old one keeps loading for ages. Can you
        dig into why the reconnection is so slow?
      </div>
      <div className="max-w-[720px] text-[14.5px] leading-relaxed text-fg-primary">
        I'll start by tracing the session switch path: what the chat socket does when the session
        id changes, and whether the old subscription is torn down before the new one hydrates.
      </div>
      <div className="max-w-[720px] text-[14.5px] leading-relaxed text-fg-muted">
        Reading <code className="font-mono text-[13px]">useChatWebSocket.ts</code> and{' '}
        <code className="font-mono text-[13px]">useSessionLifecycle.ts</code>…
      </div>
    </div>
  );
}

function FooterSlab({ notice }: { notice?: ReactNode }) {
  return (
    <Pane variant="slab" className="shrink-0 overflow-hidden">
      {notice}
      <div className="flex items-center gap-2 p-3">
        <div className="sam-well min-h-11 flex-1 rounded-[var(--sam-radius-control)] px-4 py-3 text-[15px] text-fg-muted">
          Message the agent…
        </div>
        <span
          className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--sam-on-accent)]"
          style={{ background: 'linear-gradient(180deg,var(--sam-accent-top),var(--sam-accent-bottom))' }}
        >
          ↑
        </span>
      </div>
    </Pane>
  );
}

function ChatColumn({
  above,
  capsule,
  footerNotice,
  headerState,
}: {
  above?: ReactNode;
  capsule?: ReactNode;
  footerNotice?: ReactNode;
  headerState?: string;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 md:gap-[var(--sam-space-gutter)]">
      {above}
      <HeaderSlab state={headerState} />
      <Pane variant="quiet" className="relative flex min-h-0 flex-1 flex-col">
        {capsule && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
            <div className="pointer-events-auto flex min-w-0 max-w-full">{capsule}</div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Transcript />
        </div>
      </Pane>
      <FooterSlab notice={footerNotice} />
    </div>
  );
}

function Sidebar() {
  const rows = [
    TITLE,
    'Port wake banner to glass',
    'Fix node reuse after deploy',
    'Trigger UX polish',
  ];
  return (
    <Pane as="aside" className="hidden w-[280px] shrink-0 flex-col gap-1 p-3 md:flex">
      <div className="px-2 pb-2 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
        Chats
      </div>
      {rows.map((r, i) => (
        <div
          key={r}
          className={`truncate rounded-[var(--sam-radius-control)] px-3 py-2.5 text-[13.5px] ${i === 0 ? 'sam-raised text-fg-primary' : 'text-fg-muted'}`}
        >
          {r}
        </div>
      ))}
    </Pane>
  );
}

// ── The notices themselves ─────────────────────────────────────────────────

function Provisioning({ stage = 0, failed = false }: { stage?: number; failed?: boolean }) {
  if (failed) {
    return (
      <NoticeSlab
        tone="danger"
        role="alert"
        icon={<XCircle size={16} />}
        title="Setup failed"
        meta={<MetaChip>3m 12s</MetaChip>}
        detail="Installing dependencies failed: devcontainer build exited with code 1 (npm ERR! ERESOLVE could not resolve peer dependency react@19)."
        actions={
          <>
            <GhostButton>View logs</GhostButton>
            <RaisedButton>Retry setup</RaisedButton>
          </>
        }
      >
        <StageTrack stages={STAGES} current={2} failed />
      </NoticeSlab>
    );
  }
  return (
    <NoticeSlab
      tone="progress"
      icon={<Server size={15} />}
      title={`${STAGES[stage]} · ${stage + 1} of 4`}
      meta={
        <>
          <span className="hidden min-w-0 sm:inline-flex">
            <MetaChip>{BRANCH}</MetaChip>
          </span>
          <MetaChip>{stage === 0 ? '18s' : '1m 47s'}</MetaChip>
        </>
      }
      detail={
        stage === 0
          ? 'Setting up a new server. This usually takes 2–4 minutes.'
          : 'Running the devcontainer post-create command. This usually takes 2–4 minutes.'
      }
      inlineActions
      actions={<RaisedButton>Logs</RaisedButton>}
    >
      <StageTrack stages={STAGES} current={stage} />
    </NoticeSlab>
  );
}

const agentMissing = (
  <NoticeSlab
    tone="danger"
    role="alert"
    icon={<KeyRound size={15} />}
    title="Agent connection missing"
    detail="Connect an account for this agent in Settings → Agents to continue."
    actions={<AccentButton>Open agent accounts</AccentButton>}
  />
);

const loopback = (
  <NoticeSlab
    tone="warning"
    role="alert"
    icon={<Link2Off size={15} />}
    title="Sign-in can't finish here"
    detail="This sign-in flow needs a local callback that this session cannot complete. Review your MCP connection for a supported sign-in method."
    actions={<RaisedButton>Review MCP connections</RaisedButton>}
  />
);

const resumeError = (
  <NoticeSlab
    tone="danger"
    role="alert"
    icon={<CloudOff size={15} />}
    title="Message not delivered"
    detail="The workspace didn't come back in time (wake timed out after 10m). Your message is still in the box."
    actions={
      <>
        <GhostButton>Dismiss</GhostButton>
        <RaisedButton>
          <RotateCw size={14} /> Retry
        </RaisedButton>
      </>
    }
  />
);

const answerSaved = (
  <NoticeSlab
    tone="success"
    compact
    icon={<span className="text-[14px] font-bold">✓</span>}
    title="Answer sent"
    detail="The agent will pick it up on its next turn."
    actions={<GhostButton>Dismiss</GhostButton>}
  />
);

const staleRow = (
  <FooterNoticeRow tone="warning" action={<GhostButton>Dismiss</GhostButton>}>
    Agent went quiet — no confirmed activity for 4 minutes
  </FooterNoticeRow>
);

const capsules = {
  connecting: <StatusCapsule tone="info" label="Connecting…" />,
  reconnecting: <StatusCapsule tone="warning" label="Reconnecting…" elapsed="12s" />,
  disconnected: (
    <StatusCapsule
      tone="danger"
      spinner={false}
      label={
        <span className="inline-flex items-center gap-1.5">
          <WifiOff size={13} /> Disconnected
        </span>
      }
      action={
        <button
          type="button"
          className="sam-raised ml-1 min-h-7 cursor-pointer rounded-full border-0 px-3 text-[12.5px] font-semibold text-fg-primary"
        >
          Retry
        </button>
      }
    />
  ),
  waking: (
    <StatusCapsule tone="progress" label="Restoring your workspace · 3 of 4" elapsed="1m 04s" />
  ),
  resuming: <StatusCapsule tone="progress" label="Waking Instant session…" elapsed="6s" />,
  capacity: (
    <StatusCapsule
      tone="warning"
      label="Waiting for server capacity · next try 19:58"
      elapsed="2m 31s"
    />
  ),
};

// ── Scenes ────────────────────────────────────────────────────────────────

function Gallery() {
  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-[var(--sam-space-gutter)]">
      <SectionLabel>Column notices — persistent or actionable</SectionLabel>
      <Provisioning stage={0} />
      <Provisioning stage={2} />
      <Provisioning failed />
      {agentMissing}
      {loopback}
      {resumeError}
      {answerSaved}
      <SectionLabel>Status capsules — transient, float over the conversation</SectionLabel>
      <div className={`${paneClassName('quiet')} flex flex-col items-center gap-3 p-5`}>
        {Object.values(capsules).map((c, i) => (
          <div key={i}>{c}</div>
        ))}
      </div>
      <SectionLabel>Footer row — inside the message box</SectionLabel>
      <FooterSlab notice={staleRow} />
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </div>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  provisioning: () => <ChatColumn headerState="Starting" above={<Provisioning stage={0} />} />,
  'provisioning-late': () => <ChatColumn headerState="Starting" above={<Provisioning stage={2} />} />,
  'provisioning-failed': () => <ChatColumn headerState="Failed" above={<Provisioning failed />} />,
  waking: () => (
    <ChatColumn
      headerState="Sleeping"
      capsule={capsules.waking}
      footerNotice={undefined}
    />
  ),
  capacity: () => <ChatColumn headerState="Sleeping" capsule={capsules.capacity} />,
  reconnecting: () => <ChatColumn capsule={capsules.reconnecting} />,
  disconnected: () => <ChatColumn capsule={capsules.disconnected} />,
  errors: () => (
    <ChatColumn
      headerState="Idle"
      above={
        <>
          {agentMissing}
          {resumeError}
        </>
      }
      footerNotice={staleRow}
    />
  ),
  stale: () => <ChatColumn headerState="Working" footerNotice={staleRow} />,
  loopback: () => <ChatColumn headerState="Idle" above={loopback} />,
};

export function ChatNoticesPrototype() {
  const [params] = useSearchParams();
  const scene = params.get('scene') ?? 'gallery';
  const theme = params.get('theme') === 'light' ? 'sam-light' : undefined;
  const render = SCENES[scene];

  return (
    <div
      data-ui-theme={theme}
      className="sam-void flex h-screen gap-[var(--sam-space-gutter)] overflow-hidden p-2.5 md:p-4"
      style={{ ['--sam-void-x' as string]: '58%' }}
    >
      <style>{SHIMMER_CSS}</style>
      {render ? (
        <>
          <Sidebar />
          {render()}
        </>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-y-auto pb-10">
          <Gallery />
        </div>
      )}
    </div>
  );
}
