import type { ActivityEventResponse } from '../../lib/api';
import { Badge, GLASS_CARD, SectionHeader } from './index';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const eventTypeColors: Record<string, string> = {
  error: 'text-red-300 bg-red-500/8 border-red-500/20',
  fail: 'text-red-300 bg-red-500/8 border-red-500/20',
  success: 'text-emerald-300 bg-emerald-500/8 border-emerald-500/20',
  complete: 'text-emerald-300 bg-emerald-500/8 border-emerald-500/20',
};

function getEventColor(eventType: string): string {
  for (const [key, value] of Object.entries(eventTypeColors)) {
    if (eventType.toLowerCase().includes(key)) return value;
  }
  return 'text-fg-muted bg-[rgba(34,197,94,0.04)] border-[rgba(34,197,94,0.08)]';
}

function getSummary(event: ActivityEventResponse): string | undefined {
  if (!event.payload) return undefined;
  const p = event.payload;
  if (typeof p.summary === 'string') return p.summary;
  if (typeof p.description === 'string') return p.description;
  if (typeof p.message === 'string') return p.message;
  if (typeof p.title === 'string') return p.title;
  return undefined;
}

function ActionRow({ event }: { event: ActivityEventResponse }) {
  const summary = getSummary(event);
  return (
    <article className={`${GLASS_CARD} p-3`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={getEventColor(event.eventType)}>{event.eventType}</Badge>
            <Badge className="border-[rgba(34,197,94,0.12)] bg-[rgba(34,197,94,0.04)] text-fg-muted">{event.actorType}</Badge>
          </div>
          {summary && (
            <p className="m-0 mt-2 text-[13px] text-fg-muted leading-relaxed break-words">{summary}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1 text-xs text-fg-muted lg:items-end">
          <span className="text-accent/70">{formatDate(event.createdAt)}</span>
        </div>
      </div>
    </article>
  );
}

interface ActionsTabProps {
  actions: ActivityEventResponse[];
}

export function ActionsTab({ actions }: ActionsTabProps) {
  return (
    <div className="space-y-2.5">
      <SectionHeader title="Recent agent actions" description="Activity events and state changes in this project." />
      {actions.map((a) => <ActionRow key={a.id} event={a} />)}
    </div>
  );
}
