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
        limit: 200,
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
        confidence: 0.9,
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
          className="flex items-center gap-1 text-sm text-[var(--sam-text-secondary)] hover:text-[var(--sam-text-primary)]"
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
    <div className={`flex flex-col gap-4 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Brain size={20} className="text-[var(--sam-text-secondary)]" />
          <h1 className="text-lg font-semibold text-[var(--sam-text-primary)]">Knowledge</h1>
          <span className="text-sm text-[var(--sam-text-secondary)]">({total})</span>
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[var(--sam-accent)] text-white rounded-md hover:opacity-90"
        >
          <Plus size={14} /> Add Entity
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="p-4 rounded-lg border border-[var(--sam-border)] bg-[var(--sam-bg-secondary)]">
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Entity name (e.g., CodeStyle, Preferences)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="px-3 py-2 text-sm rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] text-[var(--sam-text-primary)]"
            />
            <div className="flex gap-3">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as KnowledgeEntityType)}
                className="px-3 py-2 text-sm rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] text-[var(--sam-text-primary)]"
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
                className="flex-1 px-3 py-2 text-sm rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] text-[var(--sam-text-primary)]"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowCreateForm(false)} className="px-3 py-1.5 text-sm rounded-md text-[var(--sam-text-secondary)] hover:bg-[var(--sam-bg-hover)]">
                Cancel
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !newName.trim()}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--sam-accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search + Filter */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--sam-text-secondary)]" />
          <input
            type="text"
            placeholder="Search entities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] text-[var(--sam-text-primary)]"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <FilterChip label="All" active={!filterType} onClick={() => setFilterType('')} />
          {KNOWLEDGE_ENTITY_TYPES.map((t) => (
            <FilterChip key={t} label={t} active={filterType === t} onClick={() => setFilterType(filterType === t ? '' : t)} />
          ))}
        </div>
      </div>

      {/* Content */}
      <div className={showDetail ? 'grid grid-cols-[1fr_1fr] gap-4' : ''}>
        {/* Entity list */}
        <div className="flex flex-col gap-2">
          {loading ? (
            <div className="text-sm text-[var(--sam-text-secondary)] py-8 text-center">Loading...</div>
          ) : filteredEntities.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Brain size={32} className="text-[var(--sam-text-secondary)] opacity-40" />
              <div className="text-sm text-[var(--sam-text-secondary)]">
                {searchQuery ? 'No matching entities found' : 'No knowledge yet. Agents will learn as they interact with you.'}
              </div>
            </div>
          ) : (
            filteredEntities.map((entity) => (
              <EntityCard
                key={entity.id}
                entity={entity}
                selected={selectedEntityId === entity.id}
                onClick={() => setSelectedEntityId(entity.id)}
                onDelete={() => void handleDelete(entity.id)}
              />
            ))
          )}
        </div>

        {/* Detail panel (desktop) */}
        {showDetail && detailEntity && (
          <div className="border-l border-[var(--sam-border)] pl-4">
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
          ? 'bg-[var(--sam-accent)] text-white border-[var(--sam-accent)]'
          : 'bg-[var(--sam-bg-secondary)] text-[var(--sam-text-secondary)] border-[var(--sam-border)] hover:bg-[var(--sam-bg-hover)]'
      }`}
    >
      {label}
    </button>
  );
}

function EntityCard({
  entity,
  selected,
  onClick,
  onDelete,
}: {
  entity: KnowledgeEntity;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-start justify-between gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
        selected
          ? 'border-[var(--sam-accent)] bg-[var(--sam-accent)]/5'
          : 'border-[var(--sam-border)] hover:bg-[var(--sam-bg-hover)]'
      }`}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-[var(--sam-text-primary)] truncate">{entity.name}</span>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${TYPE_COLORS[entity.entityType] || TYPE_COLORS.custom}`}>
            {entity.entityType}
          </span>
        </div>
        {entity.description && (
          <p className="text-xs text-[var(--sam-text-secondary)] line-clamp-2">{entity.description}</p>
        )}
        <div className="flex items-center gap-3 text-[10px] text-[var(--sam-text-secondary)]">
          <span>{entity.observationCount} observation{entity.observationCount !== 1 ? 's' : ''}</span>
          <span>{new Date(entity.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 p-1 text-[var(--sam-text-secondary)] hover:text-red-500 transition-opacity"
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
    return <div className="text-sm text-[var(--sam-text-secondary)] py-4">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Entity header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--sam-text-primary)]">{entity.name}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className={`px-2 py-0.5 text-xs font-medium rounded ${TYPE_COLORS[entity.entityType] || TYPE_COLORS.custom}`}>
              {entity.entityType}
            </span>
          </div>
          {entity.description && (
            <p className="mt-2 text-sm text-[var(--sam-text-secondary)]">{entity.description}</p>
          )}
        </div>
        <button onClick={onDelete} className="p-1.5 text-[var(--sam-text-secondary)] hover:text-red-500" aria-label="Delete entity">
          <Trash2 size={16} />
        </button>
      </div>

      {/* Observations */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--sam-text-primary)]">Observations ({observations.length})</h3>
          <button
            onClick={() => setShowAddObs(!showAddObs)}
            className="flex items-center gap-1 text-xs text-[var(--sam-accent)] hover:opacity-80"
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
              className="flex-1 px-3 py-1.5 text-sm rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] text-[var(--sam-text-primary)]"
            />
            <button
              onClick={() => void onAddObservation()}
              disabled={addingObs || !newObsContent.trim()}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--sam-accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {addingObs ? '...' : 'Add'}
            </button>
          </div>
        )}

        {observations.length === 0 ? (
          <div className="text-xs text-[var(--sam-text-secondary)] py-2">No observations yet</div>
        ) : (
          observations.map((obs) => (
            <div key={obs.id} className="group flex items-start gap-2 p-2 rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-secondary)]">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--sam-text-primary)] break-words">{obs.content}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--sam-bg-primary)] text-[var(--sam-text-secondary)]">
                    {SOURCE_LABELS[obs.sourceType] || obs.sourceType}
                  </span>
                  <ConfidenceBar confidence={obs.confidence} />
                  <span className="text-[10px] text-[var(--sam-text-secondary)]">
                    {new Date(obs.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <button
                onClick={() => onDeleteObservation(obs.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-[var(--sam-text-secondary)] hover:text-red-500 transition-opacity shrink-0"
                aria-label="Delete observation"
              >
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Relations */}
      {relations.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-[var(--sam-text-primary)]">Relations ({relations.length})</h3>
          {relations.map((rel) => (
            <div key={rel.id} className="text-xs text-[var(--sam-text-secondary)] p-2 rounded-md border border-[var(--sam-border)]">
              <span className="font-medium">{rel.relationType}</span>
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
      <div className="w-12 h-1.5 rounded-full bg-[var(--sam-border)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--sam-accent)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-[var(--sam-text-secondary)]">{pct}%</span>
    </div>
  );
}
