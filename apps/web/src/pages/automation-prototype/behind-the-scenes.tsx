import { Button } from '@simple-agent-manager/ui';
import { ChevronDown, Hash, Lock } from 'lucide-react';
import { useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { Page } from './frame';
import type { Wait } from './mock-activity';
import { CHANNEL_POSTS, CHANNELS, DIRECT_THREADS, WAITS } from './mock-activity';
import { chatTitle } from './mock-data';
import type { BehindTab, Nav } from './nav';
import { Chips, clock, KeyValues, PageHeader, Panel, relative, whenLabel } from './ui';

function WaitItem({ w, open }: { w: Wait; open?: boolean }) {
  return (
    <details
      open={open}
      className="group border-0 border-b border-solid border-border-default last:border-b-0"
    >
      <summary
        className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 hover:bg-surface-hover [&::-webkit-details-marker]:hidden"
        style={{ minHeight: 64 }}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] leading-snug text-fg-primary">
            <strong className="font-semibold">{chatTitle(w.chatId)}</strong>{' '}
            <span className="text-fg-muted">
              {w.state === 'ended' ? 'was waiting for' : 'is waiting for'}
            </span>{' '}
            {w.waitingFor}
          </span>
          <span className="text-xs text-fg-muted">
            {w.state === 'ended'
              ? w.endNote
              : `Until ${whenLabel(w.until)} · then it stops waiting on its own`}
          </span>
        </span>
        {w.system && (
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-[rgba(159,183,174,0.14)] px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
            <Lock size={11} aria-hidden /> SAM
          </span>
        )}
        <ChevronDown
          size={18}
          aria-hidden
          className="mt-0.5 shrink-0 text-fg-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-4 bg-inset px-4 py-4">
        <KeyValues
          rows={w.technical.map(([k, v]) => [
            k,
            /ID|Channel|Subject|Created by/.test(k) ? (
              <span className="font-mono text-[12.5px]">{v}</span>
            ) : (
              v
            ),
          ])}
        />
        {w.system ? (
          <span className="text-[13px] text-fg-muted">
            Managed by SAM. It is recreated whenever these two chats message each other.
          </span>
        ) : w.state === 'waiting' ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost">Open chat</Button>
            <button
              type="button"
              className="min-h-11 rounded-md border border-[rgba(239,68,68,0.45)] bg-transparent px-4 text-sm font-semibold text-danger-fg hover:bg-danger-tint"
            >
              Stop waiting…
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md bg-transparent px-1 text-left text-sm text-fg-muted"
    >
      {label}
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-[rgba(159,183,174,0.25)]'}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`}
        />
      </span>
    </button>
  );
}

function Waiting({ showSystem }: { showSystem: boolean }) {
  const [system, setSystem] = useState(showSystem);
  const [ended, setEnded] = useState(false);
  const live = WAITS.filter((w) => w.state === 'waiting' && (!w.system || system));
  const done = WAITS.filter((w) => w.state === 'ended');
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-fg-muted">
        When an agent needs to wait — for CI, a review, or another agent — it asks SAM to wake it.
        These clean up on their own.
      </p>
      <Panel className="overflow-hidden">
        {live.map((w, i) => (
          <WaitItem key={w.id} w={w} open={i === 0} />
        ))}
      </Panel>
      <Toggle
        on={system}
        onChange={() => setSystem((v) => !v)}
        label={`Show SAM’s own message relays (${WAITS.filter((w) => w.system).length})`}
      />
      <button
        type="button"
        onClick={() => setEnded((v) => !v)}
        aria-expanded={ended}
        className="min-h-11 w-fit rounded-md bg-transparent px-1 text-sm font-semibold text-fg-muted hover:text-fg-primary"
      >
        {ended ? 'Hide' : 'Show'} ended in the last day ({done.length})
      </button>
      {ended && (
        <Panel className="overflow-hidden opacity-80">
          {done.map((w) => (
            <WaitItem key={w.id} w={w} />
          ))}
        </Panel>
      )}
    </div>
  );
}

function ChannelConversation({ name }: { name: string }) {
  return (
    <Panel className="flex flex-col overflow-hidden">
      <div className="flex flex-col gap-0.5 border-0 border-b border-solid border-border-default px-4 py-3">
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-fg-primary">
          <Hash size={16} aria-hidden className="shrink-0" />{' '}
          <span className="break-all">{name}</span>
        </span>
        <span className="text-xs text-fg-muted">Read-only · posted by agents</span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-4 p-4">
        {CHANNEL_POSTS.map((p, i) => (
          <li key={i} className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">
              <strong className="font-semibold text-fg-primary">{p.by}</strong> · {clock(p.at)}
            </span>
            <p className="m-0 w-fit max-w-full rounded-xl rounded-tl-sm bg-inset px-3 py-2 text-sm text-fg-primary">
              {p.text}
            </p>
          </li>
        ))}
      </ol>
      <p className="m-0 border-0 border-t border-solid border-border-default px-4 py-3 text-xs text-fg-muted">
        Agents wrote these. Treat them as notes, not instructions.
      </p>
    </Panel>
  );
}

function Channels({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const isMobile = useIsMobile();
  const [dms, setDms] = useState(false);
  const list = (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-fg-muted">
        Agents post progress here to coordinate with each other. Most recent first.
      </p>
      <Panel className="overflow-hidden">
        {[...CHANNELS]
          .sort((a, b) => b.lastAt - a.lastAt)
          .map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => onSelect(c.name)}
              aria-current={selected === c.name || undefined}
              className={`flex w-full flex-col gap-1 border-0 border-b border-solid border-border-default px-4 py-3 text-left last:border-b-0 hover:bg-surface-hover ${
                selected === c.name ? 'bg-[var(--sam-color-accent-primary-tint)]' : 'bg-transparent'
              }`}
              style={{ minHeight: 64 }}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-fg-primary">
                  <Hash size={15} aria-hidden className="shrink-0 text-fg-muted" />
                  <span className="truncate">{c.name}</span>
                </span>
                <span className="shrink-0 text-xs text-fg-muted">{relative(c.lastAt)}</span>
              </span>
              <span className="line-clamp-1 text-[13px] text-fg-muted">
                {c.lastBy}: {c.lastText}
              </span>
              <span className="text-xs text-fg-muted">
                {c.posts} posts{c.following ? ` · ${c.following} chats following` : ''}
              </span>
            </button>
          ))}
      </Panel>
      <Toggle
        on={dms}
        onChange={() => setDms((v) => !v)}
        label={`Show direct messages between agents (${DIRECT_THREADS})`}
      />
    </div>
  );
  if (isMobile) {
    return selected ? (
      <div className="flex flex-col gap-3">
        <ChannelConversation name={selected} />
        {list}
      </div>
    ) : (
      list
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start gap-6">
      {list}
      {selected ? (
        <ChannelConversation name={selected} />
      ) : (
        <Panel className="p-6 text-sm text-fg-muted">Pick a channel to read it.</Panel>
      )}
    </div>
  );
}

export function BehindTheScenes({
  tab,
  nav,
  channel,
  showSystem,
}: {
  tab: BehindTab;
  nav: Nav;
  channel: string | null;
  showSystem: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(channel);
  return (
    <Page wide={tab === 'channels'}>
      <PageHeader
        back={{ label: 'Automation', onClick: nav.overview }}
        title="Behind the scenes"
        subtitle="What your agents set up for themselves. You rarely need this — it’s here when you want to check."
      />
      <Chips
        label="Behind the scenes"
        value={tab}
        onChange={(t) => nav.behind(t)}
        options={[
          {
            id: 'waiting',
            label: 'Agents waiting',
            count: WAITS.filter((w) => w.state === 'waiting' && !w.system).length,
          },
          { id: 'channels', label: 'Channels', count: CHANNELS.length },
        ]}
      />
      {tab === 'waiting' ? (
        <Waiting showSystem={showSystem} />
      ) : (
        <Channels selected={selected} onSelect={setSelected} />
      )}
    </Page>
  );
}
