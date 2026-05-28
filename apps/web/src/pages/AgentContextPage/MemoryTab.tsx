import type { KnowledgeEntity } from '@simple-agent-manager/shared';

import { Badge, GLASS_CARD, GLASS_CARD_MUTED, SectionHeader } from './index';

const entityTypeColors: Record<string, string> = {
  preference: 'bg-blue-500/8 text-blue-300 border-blue-500/20',
  context: 'bg-amber-500/8 text-amber-300 border-amber-500/20',
  workflow: 'bg-emerald-500/8 text-emerald-300 border-emerald-500/20',
  expertise: 'bg-purple-500/8 text-purple-300 border-purple-500/20',
  style: 'bg-sky-500/8 text-sky-300 border-sky-500/20',
  personality: 'bg-pink-500/8 text-pink-300 border-pink-500/20',
  custom: 'bg-zinc-500/8 text-zinc-300 border-zinc-500/20',
};

function getTypeColor(type: string): string {
  return entityTypeColors[type] ?? 'bg-zinc-500/8 text-zinc-300 border-zinc-500/20';
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function MemoryCard({ entity }: { entity: KnowledgeEntity }) {
  return (
    <article className={`${GLASS_CARD} p-3`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={getTypeColor(entity.entityType)}>{entity.entityType}</Badge>
          </div>
          <h3 className="m-0 mt-2.5 text-sm font-medium text-fg-primary leading-relaxed break-words">{entity.name}</h3>
          {entity.description && (
            <p className="m-0 mt-1.5 text-[13px] text-fg-muted leading-relaxed break-words">{entity.description}</p>
          )}
        </div>
        <div className="shrink-0">
          <div className={`${GLASS_CARD_MUTED} p-2 text-xs text-fg-muted`}>
            <div className="text-accent font-semibold">{entity.observationCount}</div>
            observations
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1.5 border-t border-[rgba(34,197,94,0.08)] pt-3 text-xs text-fg-muted md:flex-row md:items-center md:justify-between">
        <span className="shrink-0 text-accent/70">Updated {formatDate(entity.updatedAt)}</span>
      </div>
    </article>
  );
}

interface MemoryTabProps {
  entities: KnowledgeEntity[];
}

export function MemoryTab({ entities }: MemoryTabProps) {
  return (
    <div className="space-y-2.5">
      <SectionHeader title="Memory" description="Project knowledge that agents may receive or search before making decisions." />
      {entities.map((e) => <MemoryCard key={e.id} entity={e} />)}
    </div>
  );
}
