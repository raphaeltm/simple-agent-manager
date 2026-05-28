import type { PolicyCategory, ProjectPolicy } from '@simple-agent-manager/shared';

import { Badge, GLASS_CARD, SectionHeader } from './index';

const categoryColors: Record<PolicyCategory, string> = {
  rule: 'border-red-500/20 bg-red-500/8 text-red-300',
  constraint: 'border-amber-500/20 bg-amber-500/8 text-amber-300',
  delegation: 'border-sky-500/20 bg-sky-500/8 text-sky-300',
  preference: 'border-emerald-500/20 bg-emerald-500/8 text-emerald-300',
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function PolicyCard({ policy }: { policy: ProjectPolicy }) {
  return (
    <article className={`${GLASS_CARD} p-3 ${!policy.active ? 'opacity-60' : ''}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={categoryColors[policy.category]}>{policy.category}</Badge>
            <Badge className={policy.active
              ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-300'
              : 'border-zinc-500/20 bg-zinc-500/8 text-zinc-400'
            }>
              {policy.active ? 'active' : 'inactive'}
            </Badge>
          </div>
          <h3 className="m-0 mt-2.5 text-sm font-medium text-fg-primary leading-relaxed break-words">{policy.title}</h3>
          <p className="m-0 mt-1.5 text-[13px] text-fg-muted leading-relaxed break-words">{policy.content}</p>
        </div>
        <div className="flex shrink-0 flex-row gap-1.5 md:flex-col md:items-end">
          <Badge className="border-[rgba(34,197,94,0.12)] bg-[rgba(34,197,94,0.04)] text-fg-muted">{Math.round(policy.confidence * 100)}%</Badge>
          <Badge className="border-[rgba(34,197,94,0.12)] bg-[rgba(34,197,94,0.04)] text-fg-muted">{policy.source}</Badge>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1.5 border-t border-[rgba(34,197,94,0.08)] pt-3 text-xs text-fg-muted sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 break-words">Source: {policy.source}</span>
        <span className="shrink-0 text-accent/70">Updated {formatDate(policy.updatedAt)}</span>
      </div>
    </article>
  );
}

interface PoliciesTabProps {
  policies: ProjectPolicy[];
}

export function PoliciesTab({ policies }: PoliciesTabProps) {
  return (
    <div className="space-y-2.5">
      <SectionHeader title="Policies" description="Durable project instructions and preferences. Instruction-only until platform enforcement exists." />
      {policies.map((p) => <PolicyCard key={p.id} policy={p} />)}
    </div>
  );
}
