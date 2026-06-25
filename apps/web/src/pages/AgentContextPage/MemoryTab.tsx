import type { KnowledgeEntity, KnowledgeEntityDetail, KnowledgeEntityType, KnowledgeObservation } from '@simple-agent-manager/shared';
import { KNOWLEDGE_ENTITY_TYPES } from '@simple-agent-manager/shared';
import { ChevronDown, Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  deleteKnowledgeEntity,
  deleteObservation,
  getKnowledgeEntity,
  updateKnowledgeEntity,
  updateObservation,
} from '../../lib/api';
import { Badge, FOCUS_RING, GLASS_CARD, GLASS_CARD_MUTED, SectionHeader } from './index';

const entityTypeColors: Record<string, string> = {
  preference: 'bg-info-tint text-info-fg border-info/30',
  context: 'bg-warning-tint text-warning-fg border-warning/30',
  workflow: 'bg-success-tint text-success-fg border-success/30',
  expertise: 'bg-purple/10 text-purple border-purple/30',
  style: 'bg-info-tint text-info-fg border-info/30',
  personality: 'bg-purple/10 text-purple border-purple/30',
  custom: 'bg-inset text-fg-muted border-border-default',
};

type DeleteTarget =
  | { kind: 'entity'; id: string; label: string }
  | { kind: 'observation'; id: string; entityId: string; label: string };

function getTypeColor(type: string): string {
  return entityTypeColors[type] ?? 'bg-inset text-fg-muted border-border-default';
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}


function IconButton({
  label,
  children,
  className = '',
  onClick,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--sam-form-border)] bg-accent-tint text-fg-muted transition-colors hover:border-[var(--sam-form-border-hover)] hover:text-fg-primary ${FOCUS_RING} ${className}`}
    >
      {children}
    </button>
  );
}

function FormButton({ children, variant = 'default', disabled = false }: { children: ReactNode; variant?: 'default' | 'danger'; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-50 ${
        variant === 'danger'
          ? 'border-danger/30 bg-danger-tint text-danger-fg hover:border-danger'
          : 'border-accent/30 bg-accent/10 text-accent hover:border-accent/50'
      }`}
    >
      {children}
    </button>
  );
}

function CancelButton({ children = 'Cancel', onClick }: { children?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={`min-h-11 rounded-lg border border-[var(--sam-form-border)] bg-transparent px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg-primary ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

function DeleteDialog({ target, busy, onCancel, onConfirm }: { target: DeleteTarget; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <button type="button" aria-label="Cancel delete" className="absolute inset-0 bg-overlay backdrop-blur-md" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="memory-delete-title"
        aria-describedby="memory-delete-description"
        className={`${GLASS_CARD} relative w-full max-w-md p-4 shadow-overlay`}
      >
        <h3 id="memory-delete-title" className="m-0 text-base font-semibold text-fg-primary">Delete {target.kind}</h3>
        <p id="memory-delete-description" className="m-0 mt-2 text-sm leading-relaxed text-fg-muted">
          This will delete <span className="text-fg-primary">{target.label}</span>. This action cannot be undone.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <CancelButton onClick={onCancel} />
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`min-h-11 rounded-lg border border-danger/30 bg-danger-tint px-3 text-sm font-medium text-danger-fg transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
          >
            {busy ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ObservationRow({
  observation,
  projectId,
  onRefreshEntity,
  onRequestDelete,
}: {
  observation: KnowledgeObservation;
  projectId: string;
  onRefreshEntity: () => Promise<void>;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(observation.content);
  const [confidence, setConfidence] = useState(Math.round(observation.confidence * 100));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) {
      setContent(observation.content);
      setConfidence(Math.round(observation.confidence * 100));
    }
  }, [editing, observation.content, observation.confidence]);

  const handleSave = async () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await updateObservation(projectId, observation.id, {
        content: trimmed,
        confidence: clampConfidence(confidence / 100),
      });
      await onRefreshEntity();
      setEditing(false);
      toast.success('Observation updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update observation');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form
        className={`${GLASS_CARD_MUTED} space-y-3 p-3`}
        onSubmit={(event) => { event.preventDefault(); void handleSave(); }}
      >
        <label className="block text-xs font-medium text-fg-muted">
          Observation
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            className={`mt-1 w-full resize-y rounded-lg border border-glass-border bg-[color-mix(in_srgb,var(--sam-color-bg-overlay)_33%,transparent)] px-3 py-2 text-sm text-fg-primary outline-none placeholder:text-fg-muted focus:border-accent/40 ${FOCUS_RING}`}
          />
        </label>
        <label className="block text-xs font-medium text-fg-muted">
          Confidence
          <input
            type="number"
            min="0"
            max="100"
            value={confidence}
            onChange={(event) => setConfidence(Number(event.target.value))}
            className={`mt-1 w-28 rounded-lg border border-glass-border bg-[color-mix(in_srgb,var(--sam-color-bg-overlay)_33%,transparent)] px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
          />
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <CancelButton onClick={() => setEditing(false)} />
          <FormButton disabled={saving}>{saving ? 'Saving...' : 'Save'}</FormButton>
        </div>
      </form>
    );
  }

  return (
    <div className={`${GLASS_CARD_MUTED} group/observation p-3`}>
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 min-w-0 flex-1 break-words text-[13px] leading-relaxed text-fg-primary">{observation.content}</p>
        <div className="flex shrink-0 gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/observation:opacity-100 sm:group-focus-within/observation:opacity-100">
          <IconButton label="Edit observation" onClick={() => setEditing(true)}><Pencil size={15} /></IconButton>
          <IconButton
            label="Delete observation"
            className="hover:border-danger hover:text-danger-fg"
            onClick={() => onRequestDelete({ kind: 'observation', id: observation.id, entityId: observation.entityId, label: observation.content.slice(0, 80) || 'observation' })}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        <Badge className="border-glass-border bg-accent-tint text-fg-muted">{Math.round(observation.confidence * 100)}%</Badge>
        <Badge className="border-glass-border bg-accent-tint text-fg-muted">{observation.sourceType}</Badge>
        <span className="text-accent/70">Confirmed {formatDate(observation.lastConfirmedAt)}</span>
      </div>
    </div>
  );
}

function EntityEditForm({
  entity,
  projectId,
  onCancel,
  onSaved,
}: {
  entity: KnowledgeEntity;
  projectId: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(entity.name);
  const [entityType, setEntityType] = useState<KnowledgeEntityType>(entity.entityType);
  const [description, setDescription] = useState(entity.description ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await updateKnowledgeEntity(projectId, entity.id, {
        name: trimmed,
        entityType,
        description: description.trim() || null,
      });
      await onSaved();
      toast.success('Memory entity updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update memory entity');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => { event.preventDefault(); void handleSave(); }}
    >
      <div className="grid gap-3 md:grid-cols-[1fr_180px]">
        <label className="block text-xs font-medium text-fg-muted">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`mt-1 w-full rounded-lg border border-glass-border bg-[color-mix(in_srgb,var(--sam-color-bg-overlay)_33%,transparent)] px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
          />
        </label>
        <label className="block text-xs font-medium text-fg-muted">
          Type
          <select
            value={entityType}
            onChange={(event) => setEntityType(event.target.value as KnowledgeEntityType)}
            className={`mt-1 w-full rounded-lg border border-glass-border bg-[color-mix(in_srgb,var(--sam-color-bg-overlay)_33%,transparent)] px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
          >
            {KNOWLEDGE_ENTITY_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium text-fg-muted">
        Description
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className={`mt-1 w-full resize-y rounded-lg border border-glass-border bg-[color-mix(in_srgb,var(--sam-color-bg-overlay)_33%,transparent)] px-3 py-2 text-sm text-fg-primary outline-none placeholder:text-fg-muted focus:border-accent/40 ${FOCUS_RING}`}
        />
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <CancelButton onClick={onCancel} />
        <FormButton disabled={saving}>{saving ? 'Saving...' : 'Save'}</FormButton>
      </div>
    </form>
  );
}

function MemoryCard({ entity, projectId, onRefresh }: { entity: KnowledgeEntity; projectId: string; onRefresh: () => Promise<void> }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<KnowledgeEntityDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refreshEntityDetail = async () => {
    const result = await getKnowledgeEntity(projectId, entity.id);
    setDetail({ ...result.entity, observations: result.observations, relations: result.relations });
  };

  useEffect(() => {
    if (!expanded || detail) return;
    const controller = new AbortController();
    setLoadingDetail(true);
    getKnowledgeEntity(projectId, entity.id)
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetail({ ...result.entity, observations: result.observations, relations: result.relations });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        toast.error(error instanceof Error ? error.message : 'Failed to load observations');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });
    return () => { controller.abort(); };
  }, [detail, entity.id, expanded, projectId, toast]);

  const handleSavedEntity = async () => {
    setEditing(false);
    setDetail(null);
    await onRefresh();
    if (expanded) await refreshEntityDetail();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === 'entity') {
        await deleteKnowledgeEntity(projectId, deleteTarget.id);
        await onRefresh();
        toast.success('Memory entity deleted');
      } else {
        await deleteObservation(projectId, deleteTarget.id);
        await refreshEntityDetail();
        await onRefresh();
        toast.success('Observation deleted');
      }
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to delete ${deleteTarget.kind}`);
    } finally {
      setDeleting(false);
    }
  };

  const observations = detail?.observations ?? [];

  return (
    <>
      <article className={`${GLASS_CARD} group p-3 transition-colors hover:border-[var(--sam-form-border-hover)]`}>
        {editing ? (
          <EntityEditForm entity={entity} projectId={projectId} onCancel={() => setEditing(false)} onSaved={handleSavedEntity} />
        ) : (
          <>
            <button
              type="button"
              onClick={() => { setExpanded((value) => !value); setEditing(false); }}
              className={`block w-full cursor-pointer bg-transparent p-0 text-left ${FOCUS_RING}`}
            >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className={getTypeColor(entity.entityType)}>{entity.entityType}</Badge>
                </div>
                <h3 className="m-0 mt-2.5 text-sm font-medium leading-relaxed text-fg-primary break-words">{entity.name}</h3>
                {entity.description && (
                  <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-fg-muted break-words">{entity.description}</p>
                )}
              </div>
              <div className="flex shrink-0 items-start gap-2">
                <div className={`${GLASS_CARD_MUTED} min-w-[78px] p-2 text-center text-xs text-fg-muted`}>
                  <div className="font-semibold text-accent">{entity.observationCount}</div>
                  observations
                </div>
                <ChevronDown className={`mt-2 shrink-0 text-fg-muted transition-transform ${expanded ? 'rotate-180' : ''}`} size={16} />
              </div>
            </div>
            </button>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-[color-mix(in_srgb,var(--sam-form-border)_80%,transparent)] pt-3 text-xs text-fg-muted">
              <span className="shrink-0 text-accent/70">Updated {formatDate(entity.updatedAt)}</span>
              <div className="flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <IconButton label="Edit memory entity" onClick={() => { setEditing(true); setExpanded(true); }}><Pencil size={15} /></IconButton>
                <IconButton
                  label="Delete memory entity"
                  className="hover:border-danger hover:text-danger-fg"
                  onClick={() => setDeleteTarget({ kind: 'entity', id: entity.id, label: entity.name })}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          </>
        )}

        {expanded && !editing && (
          <div className="mt-3 space-y-2 border-t border-[color-mix(in_srgb,var(--sam-form-border)_80%,transparent)] pt-3">
            {loadingDetail && <p className="m-0 text-sm text-fg-muted">Loading observations...</p>}
            {!loadingDetail && observations.length === 0 && (
              <div className={`${GLASS_CARD_MUTED} p-3 text-sm text-fg-muted`}>No observations attached to this entity.</div>
            )}
            {observations.map((observation) => (
              <ObservationRow
                key={observation.id}
                observation={observation}
                projectId={projectId}
                onRefreshEntity={refreshEntityDetail}
                onRequestDelete={setDeleteTarget}
              />
            ))}
          </div>
        )}
      </article>
      {deleteTarget && (
        <DeleteDialog
          target={deleteTarget}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => { void handleDelete(); }}
        />
      )}
    </>
  );
}

interface MemoryTabProps {
  entities: KnowledgeEntity[];
  projectId: string;
  onRefresh: () => Promise<void>;
}

export function MemoryTab({ entities, projectId, onRefresh }: MemoryTabProps) {
  return (
    <div className="space-y-2.5">
      <SectionHeader title="Memory" description="Project knowledge that agents may receive or search before making decisions." />
      {entities.map((entity) => <MemoryCard key={entity.id} entity={entity} projectId={projectId} onRefresh={onRefresh} />)}
    </div>
  );
}
