import type { ListKnowledgeEntitiesResponse } from '@simple-agent-manager/shared';
import type { ProjectPolicy } from '@simple-agent-manager/shared';
import {
  Activity,
  Brain,
  Eye,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ActivityEventResponse } from '../../lib/api';
import { listActivityEvents, listKnowledgeEntities, listPolicies } from '../../lib/api';
import { useProjectContext } from '../ProjectContext';
import { ActionsTab } from './ActionsTab';
import { MemoryTab } from './MemoryTab';
import { OverviewTab } from './OverviewTab';
import { PoliciesTab } from './PoliciesTab';

// ── Shared glass styling constants ──────────────────────────────────────────

export const GLASS_CARD = 'rounded-lg border border-[var(--sam-form-border)] bg-[var(--sam-glass-nested-bg)]';
export const GLASS_CARD_HOVER = `${GLASS_CARD} hover:border-[var(--sam-form-border-hover)] transition-colors`;
export const GLASS_CARD_MUTED = 'rounded-md bg-accent-tint border border-[color-mix(in_srgb,var(--sam-form-border)_60%,transparent)]';
export const GLASS_BADGE = 'inline-flex min-h-[22px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight';
export const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// ── Shared primitive components ─────────────────────────────────────────────

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`${GLASS_BADGE} ${className}`}>{children}</span>;
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`${GLASS_CARD} p-3 md:p-4 ${className}`}>{children}</section>;
}

export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-w-0 px-1">
      <h2 className="m-0 text-base font-semibold text-fg-primary">{title}</h2>
      <p className="m-0 mt-1 text-sm text-fg-muted leading-relaxed max-w-3xl">{description}</p>
    </div>
  );
}

// ── Tab types ───────────────────────────────────────────────────────────────

type TabId = 'overview' | 'memory' | 'policies' | 'actions';

const TABS: Array<{ id: TabId; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Eye size={15} /> },
  { id: 'memory', label: 'Memory', icon: <Brain size={15} /> },
  { id: 'policies', label: 'Policies', icon: <ShieldCheck size={15} /> },
  { id: 'actions', label: 'Agent actions', icon: <Activity size={15} /> },
];

// ── Main component ──────────────────────────────────────────────────────────

export function AgentContextPage() {
  const { projectId } = useProjectContext();
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [filter, setFilter] = useState('');

  // Data state
  const [knowledgeData, setKnowledgeData] = useState<ListKnowledgeEntitiesResponse | null>(null);
  const [policiesData, setPoliciesData] = useState<ProjectPolicy[]>([]);
  const [actionsData, setActionsData] = useState<ActivityEventResponse[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [kRes, pRes, aRes] = await Promise.all([
        listKnowledgeEntities(projectId, { limit: 100 }),
        listPolicies(projectId, { limit: 100 }),
        listActivityEvents(projectId, { limit: 50 }),
      ]);
      setKnowledgeData(kRes);
      setPoliciesData(pRes.policies);
      setActionsData(aRes.events);
    } catch {
      // Best-effort — individual tabs handle empty state
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadData(); }, [loadData]);

  // Filter logic
  const q = filter.trim().toLowerCase();
  const entities = useMemo(() => knowledgeData?.entities ?? [], [knowledgeData]);
  const filteredEntities = useMemo(() =>
    entities.filter((e) => `${e.name} ${e.entityType}`.toLowerCase().includes(q)),
    [entities, q],
  );
  const filteredPolicies = useMemo(() =>
    policiesData.filter((p) => `${p.title} ${p.content} ${p.category}`.toLowerCase().includes(q)),
    [policiesData, q],
  );
  const filteredActions = useMemo(() =>
    actionsData.filter((a) => `${a.eventType} ${a.actorType}`.toLowerCase().includes(q)),
    [actionsData, q],
  );

  const visibleCount = activeTab === 'memory' ? filteredEntities.length
    : activeTab === 'policies' ? filteredPolicies.length
    : activeTab === 'actions' ? filteredActions.length
    : 0;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-3 py-3 sm:px-4 md:px-6 md:py-5">
      {/* Tab bar */}
      <div role="tablist" aria-label="Agent context" className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={active}
              aria-controls={`tabpanel-${tab.id}`}
              onClick={() => { setActiveTab(tab.id); setFilter(''); }}
              className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors bg-transparent cursor-pointer ${FOCUS_RING} ${
                active
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-[color-mix(in_srgb,var(--sam-form-border)_80%,transparent)] text-fg-muted hover:text-fg-primary hover:border-[var(--sam-form-border-hover)]'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div id={`tabpanel-${activeTab}`} role="tabpanel" aria-label={TABS.find((t) => t.id === activeTab)?.label} className="mt-4 flex-1 space-y-3 pb-8">
        {activeTab !== 'overview' && (
          <label className={`flex min-h-11 items-center gap-2 px-3 text-sm text-fg-muted ${GLASS_CARD} focus-within:border-[var(--sam-form-border-focus)]`}>
            <Search size={15} className="shrink-0 text-fg-muted" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter..."
              className="min-w-0 flex-1 bg-transparent text-fg-primary outline-none focus-visible:ring-1 focus-visible:ring-accent placeholder:text-fg-muted"
            />
          </label>
        )}

        {loading && activeTab !== 'overview' && (
          <div className="py-12 text-center text-sm text-fg-muted">Loading...</div>
        )}

        {activeTab === 'overview' && (
          <OverviewTab
            entityCount={entities.length}
            activePolicyCount={policiesData.filter((p) => p.active).length}
            actionCount={actionsData.length}
            actions={actionsData}
            loading={loading}
            setActiveTab={setActiveTab}
          />
        )}

        {activeTab === 'memory' && !loading && (
          <MemoryTab entities={filteredEntities} projectId={projectId} onRefresh={loadData} />
        )}

        {activeTab === 'policies' && !loading && (
          <PoliciesTab policies={filteredPolicies} projectId={projectId} onRefresh={loadData} />
        )}

        {activeTab === 'actions' && !loading && (
          <ActionsTab actions={filteredActions} />
        )}

        {activeTab !== 'overview' && !loading && visibleCount === 0 && (
          <Panel className="border-dashed">
            <div className="flex items-start gap-3">
              <SlidersHorizontal className="mt-0.5 shrink-0 text-fg-muted" size={16} />
              <p className="m-0 text-sm leading-relaxed text-fg-muted">
                {filter ? 'No results match your filter. Try a broader search.' : 'No data yet.'}
              </p>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
