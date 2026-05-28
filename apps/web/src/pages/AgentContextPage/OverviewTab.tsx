import {
  Activity,
  Brain,
  ChevronRight,
  FileText,
  Info,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { ActivityEventResponse } from '../../lib/api';
import { FOCUS_RING, GLASS_CARD, GLASS_CARD_HOVER, GLASS_CARD_MUTED, Panel, SectionHeader } from './index';

function Metric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className={`${GLASS_CARD} p-3 min-w-0`}>
      <div className="flex items-center gap-2 text-fg-muted text-xs">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-fg-primary leading-none">{value}</div>
    </div>
  );
}

interface OverviewTabProps {
  entityCount: number;
  activePolicyCount: number;
  actionCount: number;
  actions: ActivityEventResponse[];
  loading: boolean;
  setActiveTab: (tab: 'overview' | 'memory' | 'policies' | 'actions') => void;
}

export function OverviewTab({ entityCount, activePolicyCount, actionCount, actions, loading, setActiveTab }: OverviewTabProps) {
  // Show actions that might need attention (errors or noteworthy events)
  const attentionActions = actions.filter((a) =>
    a.eventType.includes('error') || a.eventType.includes('fail') || a.eventType.includes('block'),
  ).slice(0, 5);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <Metric label="Memory entities" value={loading ? '—' : String(entityCount)} icon={<Brain size={14} />} />
        <Metric label="Active policies" value={loading ? '—' : String(activePolicyCount)} icon={<ShieldCheck size={14} />} />
        <Metric label="Recent actions" value={loading ? '—' : String(actionCount)} icon={<Activity size={14} />} />
      </div>

      <Panel>
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 shrink-0 text-accent" size={16} />
          <div className="min-w-0">
            <h2 className="m-0 text-sm font-semibold text-fg-primary">Project-scoped agent context</h2>
            <p className="m-0 mt-1 text-[13px] leading-relaxed text-fg-muted">
              Inspect what agents remember, which policies apply, and what actions happened recently in this project.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
        {attentionActions.length > 0 && (
          <Panel>
            <SectionHeader title="Needs attention" description="Trust and debugging signals." />
            <div className="mt-3 space-y-2">
              {attentionActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => setActiveTab('actions')}
                  className={`flex min-h-[48px] w-full items-center justify-between gap-3 p-3 text-left text-[13px] text-fg-primary cursor-pointer bg-transparent border-none ${GLASS_CARD_HOVER} ${FOCUS_RING}`}
                >
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{action.eventType}:</span>{' '}
                    <span className="text-fg-muted">{(action.payload as Record<string, unknown>)?.summary as string ?? action.actorType}</span>
                  </span>
                  <ChevronRight className="shrink-0 text-fg-muted" size={14} />
                </button>
              ))}
            </div>
          </Panel>
        )}

        <Panel>
          <SectionHeader title="Context stack" description="What agents see for this project." />
          <div className="mt-3 space-y-1.5">
            {[
              ['Repository instructions', 'CLAUDE.md, AGENTS.md, .claude/rules'],
              ['Memory', `${entityCount} high-confidence entities`],
              ['Policies', `${activePolicyCount} active instruction-only policies`],
              ['Profiles', 'Linked from project profile settings'],
            ].map(([title, detail]) => (
              <div key={title} className={`flex items-start gap-3 p-2.5 ${GLASS_CARD_MUTED}`}>
                <FileText className="mt-0.5 shrink-0 text-accent/50" size={14} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg-primary">{title}</div>
                  <div className="text-xs leading-5 text-fg-muted break-words">{detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
