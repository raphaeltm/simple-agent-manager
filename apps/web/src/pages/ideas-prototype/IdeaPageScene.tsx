/** Ideas redesign prototype: one idea's page (throwaway; never merge to main). */
import { Button } from '@simple-agent-manager/ui';
import { ChevronLeft, History, Play, SendHorizontal } from 'lucide-react';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { IdeaPageData, IdeaState } from './mock-data';
import { Card, LiveDot, RelatedRow, SectionHeading, STATE_META, StateIcon, UpdateRow, WorkRow } from './parts';
import { StartWorkSheet } from './StartWorkSheet';

/** Where the status came from, so nobody has to trust a hand-set label. */
const STATUS_SOURCE: Partial<Record<IdeaState, string>> = {
  working: 'From the linked chat',
  review: 'From GitHub, a minute ago',
  done: 'Marked done by you after PR #482 merged',
};

function StatusCard({ data, isMobile }: { data: IdeaPageData; isMobile: boolean }) {
  const meta = STATE_META[data.state];
  const source = STATUS_SOURCE[data.state];
  return (
    <Card label="Status" className="flex flex-col gap-4 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <StateIcon state={data.state} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[17px] font-bold leading-tight" style={{ color: meta.color }}>
            {data.statusLine}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-sm text-fg-primary">
            {data.state === 'working' && <LiveDot />}
            <span className="break-words">{data.statusDetail}</span>
          </span>
          {source && <span className="text-xs text-fg-muted">{source}</span>}
        </div>
      </div>
      <div className={`flex gap-3 ${isMobile ? 'flex-col' : 'flex-wrap'}`}>
        <Button size={isMobile ? 'lg' : 'md'} className={isMobile ? 'w-full' : ''}>
          {data.state === 'not-started' && <Play size={17} aria-hidden />}
          {data.primaryAction}
        </Button>
        {data.secondaryAction && (
          <Button variant="ghost" className={isMobile ? 'w-full' : ''}>
            {data.secondaryAction}
          </Button>
        )}
      </div>
    </Card>
  );
}

function IdeaText({ data }: { data: IdeaPageData }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="The idea" hint="Always the current plan" />
      <Card label="The idea" className="flex flex-col">
        {/* list-disc: the shared renderer drops list markers today (idea 01M0JQBW9E0T5PJZXY0K72V9BX). */}
        <div className="px-4 pb-1 pt-3 text-[15px] [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_li]:pl-1">
          <RenderedMarkdown content={data.text} inline />
        </div>
        <a
          href="#history"
          className="flex min-h-11 items-center gap-2 border-0 border-t border-solid border-border-default px-4 text-[13px] text-fg-muted no-underline hover:bg-surface-hover"
        >
          <History size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{data.editedNote}</span>
          <span className="shrink-0 font-semibold text-accent">History</span>
        </a>
      </Card>
    </div>
  );
}

function Work({ data }: { data: IdeaPageData }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="Work" count={data.work.length} hint="Chats and pull requests for this idea" />
      <Card label="Work">
        {data.work.map((item) => (
          <WorkRow key={item.id} item={item} />
        ))}
      </Card>
    </div>
  );
}

function Updates({ data }: { data: IdeaPageData }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="Updates" count={data.updates.length} hint="Notes from people and agents, newest first" />
      <Card label="Updates">
        <div className="flex items-center gap-2 border-0 border-b border-solid border-border-default p-3">
          <input
            type="text"
            placeholder="Add an update…"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            aria-label="Post update"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-accent text-fg-on-accent"
          >
            <SendHorizontal size={17} aria-hidden />
          </button>
        </div>
        <ol className="m-0 list-none p-0">
          {data.updates.map((update) => (
            <UpdateRow key={update.id} update={update} />
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Related({ data }: { data: IdeaPageData }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading title="Related" count={data.related.length} hint="Linked automatically as agents work" />
      <Card label="Related">
        {data.related.map((item) => (
          <RelatedRow key={item.id} item={item} />
        ))}
      </Card>
    </div>
  );
}

export function IdeaPageScene({ data, sheet }: { data: IdeaPageData; sheet?: 'work' | 'chat' }) {
  const isMobile = useIsMobile();
  const header = (
    <header className="flex flex-col gap-2">
      <a
        href="#ideas"
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
      >
        <ChevronLeft size={16} aria-hidden />
        Ideas
      </a>
      <h1 className="m-0 break-words text-[24px] font-bold leading-tight tracking-[-0.01em] text-fg-primary [overflow-wrap:anywhere]">
        {data.title}
      </h1>
    </header>
  );

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-6 pb-16">
      {isMobile ? (
        <>
          {header}
          <StatusCard data={data} isMobile />
          <IdeaText data={data} />
          <Work data={data} />
          <Updates data={data} />
          <Related data={data} />
        </>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
          <div className="flex min-w-0 flex-col gap-6">
            {header}
            <IdeaText data={data} />
            <Updates data={data} />
          </div>
          <div className="flex min-w-0 flex-col gap-6 lg:pt-[60px]">
            <StatusCard data={data} isMobile={false} />
            <Work data={data} />
            <Related data={data} />
          </div>
        </div>
      )}
      {sheet && <StartWorkSheet variant={sheet} />}
    </div>
  );
}
