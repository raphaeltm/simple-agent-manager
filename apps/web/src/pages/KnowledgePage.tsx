/**
 * Knowledge Browser page — browse, search, and manage project knowledge entities.
 */
import type {
  KnowledgeEntity,
  KnowledgeEntityType,
  KnowledgeObservation,
  KnowledgeRelation,
} from '@simple-agent-manager/shared';
import { KNOWLEDGE_ENTITY_TYPES } from '@simple-agent-manager/shared';
import {
  Brain,
  ChevronLeft,
  Eye,
  MessageSquareText,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';

import { useIsMobile } from '../hooks/useIsMobile';
import {
  addObservation,
  createKnowledgeEntity,
  deleteKnowledgeEntity,
  deleteObservation,
  getKnowledgeEntity,
  listKnowledgeEntities,
} from '../lib/api';

// ─── Configurable defaults (Constitution Principle XI) ────────────────────────

const KNOWLEDGE_LIST_FETCH_LIMIT = Number(
  import.meta.env.VITE_KNOWLEDGE_LIST_FETCH_LIMIT ?? 200,
);
const EXPLICIT_OBSERVATION_CONFIDENCE = Number(
  import.meta.env.VITE_EXPLICIT_OBSERVATION_CONFIDENCE ?? 0.9,
);

// ─── Type badge colors ──────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  preference: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  style: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  context: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  expertise: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  workflow: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  personality: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300',
  custom: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300',
};

const SOURCE_LABELS: Record<string, string> = {
  explicit: 'You said',
  inferred: 'Inferred',
  behavioral: 'Observed',
};

// ─── Main Component ─────────────────────────────────────────────────────────

export function KnowledgePage() {
  const { id: projectId } = useParams<{ id: string }>();
  const isMobile = useIsMobile();

  const [entities, setEntities] = useState<KnowledgeEntity[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('');
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Detail panel state
  const [detailEntity, setDetailEntity] = useState<KnowledgeEntity | null>(null);
  const [detailObservations, setDetailObservations] = useState<KnowledgeObservation[]>([]);
  const [detailRelations, setDetailRelations] = useState<KnowledgeRelation[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<KnowledgeEntityType>('preference');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Add observation form
  const [showAddObs, setShowAddObs] = useState(false);
  const [newObsContent, setNewObsContent] = useState('');
  const [addingObs, setAddingObs] = useState(false);

  const loadEntities = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await listKnowledgeEntities(projectId, {
        entityType: filterType || undefined,
        limit: KNOWLEDGE_LIST_FETCH_LIMIT,
      });
      setEntities(result.entities);
      setTotal(result.total);
    } catch (err) {
      console.error('Failed to load knowledge entities:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, filterType]);

  const loadEntityDetail = useCallback(async (entityId: string) => {
    if (!projectId) return;
    setDetailLoading(true);
    try {
      const result = await getKnowledgeEntity(projectId, entityId);
      setDetailEntity(result.entity as unknown as KnowledgeEntity);
      setDetailObservations(result.observations);
      setDetailRelations(result.relations);
    } catch (err) {
      console.error('Failed to load entity detail:', err);
    } finally {
      setDetailLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadEntities(); }, [loadEntities]);

  useEffect(() => {
    if (selectedEntityId) void loadEntityDetail(selectedEntityId);
  }, [selectedEntityId, loadEntityDetail]);

  // Filter entities by search query (client-side for fast UX)
  const filteredEntities = useMemo(() => {
    if (!searchQuery.trim()) return entities;
    const q = searchQuery.toLowerCase();
    return entities.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description?.toLowerCase().includes(q),
    );
  }, [entities, searchQuery]);

  // Handlers
  const handleCreate = async () => {
    if (!projectId || !newName.trim()) return;
    setCreating(true);
    try {
      await createKnowledgeEntity(projectId, {
        name: newName.trim(),
        entityType: newType,
        description: newDescription.trim() || undefined,
      });
      setNewName('');
      setNewDescription('');
      setShowCreateForm(false);
      void loadEntities();
    } catch (err) {
      console.error('Failed to create entity:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (entityId: string) => {
    if (!projectId) return;
    try {
      await deleteKnowledgeEntity(projectId, entityId);
      if (selectedEntityId === entityId) {
        setSelectedEntityId(null);
        setDetailEntity(null);
      }
      void loadEntities();
    } catch (err) {
      console.error('Failed to delete entity:', err);
    }
  };

  const handleAddObservation = async () => {
    if (!projectId || !selectedEntityId || !newObsContent.trim()) return;
    setAddingObs(true);
    try {
      await addObservation(projectId, selectedEntityId, {
        content: newObsContent.trim(),
        sourceType: 'explicit',
        confidence: EXPLICIT_OBSERVATION_CONFIDENCE,
      });
      setNewObsContent('');
      setShowAddObs(false);
      void loadEntityDetail(selectedEntityId);
      void loadEntities();
    } catch (err) {
      console.error('Failed to add observation:', err);
    } finally {
      setAddingObs(false);
    }
  };

  const handleDeleteObservation = async (observationId: string) => {
    if (!projectId || !selectedEntityId) return;
    try {
      await deleteObservation(projectId, observationId);
      void loadEntityDetail(selectedEntityId);
      void loadEntities();
    } catch (err) {
      console.error('Failed to delete observation:', err);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  const showDetail = selectedEntityId && detailEntity && !isMobile;
  const showMobileDetail = selectedEntityId && isMobile;

  if (showMobileDetail && detailEntity) {
    return (
      <div className="flex flex-col gap-3 px-4 py-3 w-full max-w-full min-w-0 overflow-x-hidden">
        <button
          onClick={() => { setSelectedEntityId(null); setDetailEntity(null); }}
          className="flex items-center gap-1 text-sm text-fg-muted hover:text-fg-primary"
        >
          <ChevronLeft size={16} /> Back to entities
        </button>
        <EntityDetail
          entity={detailEntity}
          observations={detailObservations}
          relations={detailRelations}
          loading={detailLoading}
          showAddObs={showAddObs}
          setShowAddObs={setShowAddObs}
          newObsContent={newObsContent}
          setNewObsContent={setNewObsContent}
          addingObs={addingObs}
          onAddObservation={handleAddObservation}
          onDeleteObservation={handleDeleteObservation}
          onDelete={() => void handleDelete(detailEntity.id)}
        />
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-fg-muted" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-fg-primary m-0">Knowledge</h1>
          <span className="text-xs text-fg-muted">({total})</span>
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-1.5 px-3 min-h-[44px] text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} /> Add Entity
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="p-3 rounded-lg border border-border-default bg-surface-inset">
          <div className="flex flex-col gap-2.5">
            <input
              type="text"
              placeholder="Entity name (e.g., CodeStyle, Preferences)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="px-3 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
            />
            <div className={`flex gap-2.5 ${isMobile ? 'flex-col' : ''}`}>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as KnowledgeEntityType)}
                className="px-3 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-primary focus:outline-none focus:border-accent shrink-0"
              >
                {KNOWLEDGE_ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Description (optional)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="flex-1 px-3 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCreateForm(false)}
                className="px-3 min-h-[44px] text-sm rounded-lg text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !newName.trim()}
                className="px-4 min-h-[44px] text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search + Filter */}
      <div className={`flex gap-2 ${isMobile ? 'flex-col' : 'items-center'}`}>
        <div className="relative flex-1 min-w-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search entities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
          />
        </div>
        {isMobile ? (
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary focus:outline-none focus:border-accent"
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            {KNOWLEDGE_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        ) : (
          <div className="flex gap-1.5 shrink-0">
            <FilterChip label="All" active={!filterType} onClick={() => setFilterType('')} />
            {KNOWLEDGE_ENTITY_TYPES.map((t) => (
              <FilterChip key={t} label={t} active={filterType === t} onClick={() => setFilterType(filterType === t ? '' : t)} />
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className={showDetail ? 'grid grid-cols-[1fr_1fr] gap-4' : ''}>
        {/* Entity list */}
        <div className={`flex flex-col gap-1.5 ${!showDetail ? 'max-w-2xl' : ''}`}>
          {loading ? (
            <div className="text-sm text-fg-muted py-8 text-center">Loading...</div>
          ) : filteredEntities.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Brain size={40} className="text-fg-muted opacity-30" aria-hidden="true" />
              <p className="text-sm text-fg-muted m-0 max-w-xs">
                {searchQuery ? 'No matching entities found' : 'No knowledge yet. Agents will learn as they interact with you.'}
              </p>
            </div>
          ) : (
            filteredEntities.map((entity) => (
              <EntityCard
                key={entity.id}
                entity={entity}
                selected={selectedEntityId === entity.id}
                isMobile={isMobile}
                onClick={() => setSelectedEntityId(entity.id)}
                onDelete={() => void handleDelete(entity.id)}
              />
            ))
          )}
        </div>

        {/* Detail panel (desktop) */}
        {showDetail && detailEntity && (
          <div className="border-l border-border-default pl-4">
            <EntityDetail
              entity={detailEntity}
              observations={detailObservations}
              relations={detailRelations}
              loading={detailLoading}
              showAddObs={showAddObs}
              setShowAddObs={setShowAddObs}
              newObsContent={newObsContent}
              setNewObsContent={setNewObsContent}
              addingObs={addingObs}
              onAddObservation={handleAddObservation}
              onDeleteObservation={handleDeleteObservation}
              onDelete={() => void handleDelete(detailEntity.id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'bg-accent text-white border-accent'
          : 'bg-surface text-fg-muted border-border-default hover:bg-accent/10 hover:text-accent'
      }`}
    >
      {label}
    </button>
  );
}

function EntityCard({
  entity,
  selected,
  isMobile,
  onClick,
  onDelete,
}: {
  entity: KnowledgeEntity;
  selected: boolean;
  isMobile: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={`group flex items-start gap-3 px-3 py-2.5 min-h-[48px] rounded-lg border transition-colors cursor-pointer text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        selected
          ? 'border-accent bg-accent/5'
          : 'border-border-default bg-surface hover:border-accent/40'
      }`}
      aria-label={`View entity: ${entity.name}`}
    >
      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg-primary line-clamp-1 flex-1 min-w-0">{entity.name}</span>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded shrink-0 ${TYPE_COLORS[entity.entityType] || TYPE_COLORS.custom}`}>
            {entity.entityType}
          </span>
        </div>
        {entity.description && (
          <p className="text-xs text-fg-muted m-0 mt-0.5 line-clamp-1">{entity.description}</p>
        )}
        <div className="flex items-center gap-3 mt-0.5 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <Eye size={11} aria-hidden="true" />
            {entity.observationCount}
          </span>
          <span>{new Date(entity.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Delete — always visible on mobile, hover on desktop */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={`p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center rounded text-fg-muted hover:text-danger transition-colors shrink-0 ${
          isMobile ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
        aria-label={`Delete ${entity.name}`}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function EntityDetail({
  entity,
  observations,
  relations,
  loading,
  showAddObs,
  setShowAddObs,
  newObsContent,
  setNewObsContent,
  addingObs,
  onAddObservation,
  onDeleteObservation,
  onDelete,
}: {
  entity: KnowledgeEntity;
  observations: KnowledgeObservation[];
  relations: KnowledgeRelation[];
  loading: boolean;
  showAddObs: boolean;
  setShowAddObs: (v: boolean) => void;
  newObsContent: string;
  setNewObsContent: (v: string) => void;
  addingObs: boolean;
  onAddObservation: () => void;
  onDeleteObservation: (id: string) => void;
  onDelete: () => void;
}) {
  if (loading) {
    return <div className="text-sm text-fg-muted py-4">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Entity header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-primary m-0">{entity.name}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className={`px-2 py-0.5 text-xs font-medium rounded ${TYPE_COLORS[entity.entityType] || TYPE_COLORS.custom}`}>
              {entity.entityType}
            </span>
          </div>
          {entity.description && (
            <p className="mt-2 text-sm text-fg-muted m-0">{entity.description}</p>
          )}
        </div>
        <button
          onClick={onDelete}
          className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-danger/10 transition-colors shrink-0"
          aria-label="Delete entity"
        >
          <Trash2 size={16} />
        </button>
      </div>

      {/* Observations */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-fg-primary m-0">Observations ({observations.length})</h3>
          <button
            onClick={() => setShowAddObs(!showAddObs)}
            className="flex items-center gap-1 text-xs text-accent hover:opacity-80 min-h-[32px]"
          >
            <Plus size={12} /> Add
          </button>
        </div>

        {showAddObs && (
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="What did you learn?"
              value={newObsContent}
              onChange={(e) => setNewObsContent(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { void onAddObservation(); } }}
              className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-border-default bg-surface text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
            />
            <button
              onClick={() => void onAddObservation()}
              disabled={addingObs || !newObsContent.trim()}
              className="px-3 min-h-[36px] text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {addingObs ? '...' : 'Add'}
            </button>
          </div>
        )}

        {observations.length === 0 ? (
          <p className="text-xs text-fg-muted py-2 m-0">No observations yet</p>
        ) : (
          <div className="flex flex-col gap-0">
            {observations.map((obs, idx) => (
              <div
                key={obs.id}
                className={`group flex items-start gap-2 py-2.5 px-1 ${
                  idx < observations.length - 1 ? 'border-b border-border-default' : ''
                }`}
              >
                <MessageSquareText size={14} className="text-fg-muted shrink-0 mt-0.5" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-fg-primary break-words m-0">{obs.content}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-inset text-fg-muted">
                      {SOURCE_LABELS[obs.sourceType] || obs.sourceType}
                    </span>
                    <ConfidenceBar confidence={obs.confidence} />
                    <span className="text-[10px] text-fg-muted">
                      {new Date(obs.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => onDeleteObservation(obs.id)}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 text-fg-muted hover:text-danger transition-opacity shrink-0"
                  aria-label="Delete observation"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Relations */}
      {relations.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg-primary m-0">Relations ({relations.length})</h3>
          {relations.map((rel) => (
            <div key={rel.id} className="text-xs text-fg-muted py-2 px-1 border-b border-border-default last:border-0">
              <span className="font-medium text-fg-primary">{rel.relationType}</span>
              {rel.description && <span> — {rel.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  return (
    <div className="flex items-center gap-1" title={`Confidence: ${pct}%`}>
      <div className="w-12 h-1.5 rounded-full bg-border-default overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-fg-muted">{pct}%</span>
    </div>
  );
}
