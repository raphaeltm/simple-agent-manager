import type { PolicyCategory, ProjectPolicy } from '@simple-agent-manager/shared';
import { POLICY_CATEGORIES } from '@simple-agent-manager/shared';
import { Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { deletePolicy, updatePolicy } from '../../lib/api';
import { Badge, FOCUS_RING, GLASS_CARD, SectionHeader } from './index';

const categoryColors: Record<PolicyCategory, string> = {
  rule: 'border-red-500/20 bg-red-500/8 text-red-300',
  constraint: 'border-amber-500/20 bg-amber-500/8 text-amber-300',
  delegation: 'border-sky-500/20 bg-sky-500/8 text-sky-300',
  preference: 'border-emerald-500/20 bg-emerald-500/8 text-emerald-300',
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}


function IconButton({ label, children, className = '', onClick }: { label: string; children: ReactNode; className?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[rgba(34,197,94,0.10)] bg-[rgba(34,197,94,0.04)] text-fg-muted transition-colors hover:border-[rgba(34,197,94,0.24)] hover:text-fg-primary ${FOCUS_RING} ${className}`}
    >
      {children}
    </button>
  );
}

function CancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={`min-h-11 rounded-lg border border-[rgba(34,197,94,0.10)] bg-transparent px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg-primary ${FOCUS_RING}`}
    >
      Cancel
    </button>
  );
}

function DeleteDialog({ policy, busy, onCancel, onConfirm }: { policy: ProjectPolicy; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <button type="button" aria-label="Cancel delete" className="absolute inset-0 bg-black/45 backdrop-blur-md" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="policy-delete-title"
        aria-describedby="policy-delete-description"
        className={`${GLASS_CARD} relative w-full max-w-md p-4 shadow-2xl shadow-black/40`}
      >
        <h3 id="policy-delete-title" className="m-0 text-base font-semibold text-fg-primary">Delete policy</h3>
        <p id="policy-delete-description" className="m-0 mt-2 text-sm leading-relaxed text-fg-muted">
          This will delete <span className="text-fg-primary">{policy.title}</span>. This action cannot be undone.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <CancelButton onClick={onCancel} />
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`min-h-11 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-sm font-medium text-red-200 transition-colors hover:border-red-500/50 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
          >
            {busy ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PolicyEditForm({ policy, projectId, onCancel, onSaved }: { policy: ProjectPolicy; projectId: string; onCancel: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState(policy.title);
  const [content, setContent] = useState(policy.content);
  const [category, setCategory] = useState<PolicyCategory>(policy.category);
  const [active, setActive] = useState(policy.active);
  const [confidence, setConfidence] = useState(Math.round(policy.confidence * 100));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (!trimmedTitle || !trimmedContent) return;
    setSaving(true);
    try {
      await updatePolicy(projectId, policy.id, {
        title: trimmedTitle,
        content: trimmedContent,
        category,
        active,
        confidence: clampConfidence(confidence / 100),
      });
      await onSaved();
      toast.success('Policy updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update policy');
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
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={`mt-1 w-full rounded-lg border border-[rgba(34,197,94,0.12)] bg-black/20 px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
          />
        </label>
        <label className="block text-xs font-medium text-fg-muted">
          Category
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as PolicyCategory)}
            className={`mt-1 w-full rounded-lg border border-[rgba(34,197,94,0.12)] bg-black/20 px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
          >
            {POLICY_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium text-fg-muted">
        Content
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={4}
          className={`mt-1 w-full resize-y rounded-lg border border-[rgba(34,197,94,0.12)] bg-black/20 px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-[150px_1fr]">
        <label className="block text-xs font-medium text-fg-muted">
          Confidence
          <input
            type="number"
            min="0"
            max="100"
            value={confidence}
            onChange={(event) => setConfidence(Number(event.target.value))}
            className={`mt-1 w-full rounded-lg border border-[rgba(34,197,94,0.12)] bg-black/20 px-3 py-2 text-sm text-fg-primary outline-none focus:border-accent/40 ${FOCUS_RING}`}
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Active policy
        </label>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <CancelButton onClick={onCancel} />
        <button
          type="submit"
          disabled={saving}
          className={`min-h-11 rounded-lg border border-accent/30 bg-accent/10 px-3 text-sm font-medium text-accent transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function PolicyCard({ policy, projectId, onRefresh }: { policy: ProjectPolicy; projectId: string; onRefresh: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSaved = async () => {
    setEditing(false);
    await onRefresh();
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deletePolicy(projectId, policy.id);
      await onRefresh();
      setConfirmDelete(false);
      toast.success('Policy deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete policy');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <article className={`${GLASS_CARD} group p-3 ${!policy.active ? 'opacity-60' : ''}`}>
        {editing ? (
          <PolicyEditForm policy={policy} projectId={projectId} onCancel={() => setEditing(false)} onSaved={handleSaved} />
        ) : (
          <>
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
                <h3 className="m-0 mt-2.5 text-sm font-medium leading-relaxed text-fg-primary break-words">{policy.title}</h3>
                <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-fg-muted break-words">{policy.content}</p>
              </div>
              <div className="flex shrink-0 flex-row items-start gap-1.5 md:items-end">
                <div className="flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <IconButton label="Edit policy" onClick={() => setEditing(true)}><Pencil size={15} /></IconButton>
                  <IconButton label="Delete policy" className="hover:border-red-500/40 hover:text-red-200" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /></IconButton>
                </div>
                <div className="flex flex-row gap-1.5 md:flex-col md:items-end">
                  <Badge className="border-[rgba(34,197,94,0.12)] bg-[rgba(34,197,94,0.04)] text-fg-muted">{Math.round(policy.confidence * 100)}%</Badge>
                  <Badge className="border-[rgba(34,197,94,0.12)] bg-[rgba(34,197,94,0.04)] text-fg-muted">{policy.source}</Badge>
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1.5 border-t border-[rgba(34,197,94,0.08)] pt-3 text-xs text-fg-muted sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words">Source: {policy.source}</span>
              <span className="shrink-0 text-accent/70">Updated {formatDate(policy.updatedAt)}</span>
            </div>
          </>
        )}
      </article>
      {confirmDelete && (
        <DeleteDialog
          policy={policy}
          busy={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { void handleDelete(); }}
        />
      )}
    </>
  );
}

interface PoliciesTabProps {
  policies: ProjectPolicy[];
  projectId: string;
  onRefresh: () => Promise<void>;
}

export function PoliciesTab({ policies, projectId, onRefresh }: PoliciesTabProps) {
  return (
    <div className="space-y-2.5">
      <SectionHeader title="Policies" description="Durable project instructions and preferences. Instruction-only until platform enforcement exists." />
      {policies.map((policy) => <PolicyCard key={policy.id} policy={policy} projectId={projectId} onRefresh={onRefresh} />)}
    </div>
  );
}
