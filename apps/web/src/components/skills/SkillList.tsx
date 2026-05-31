import type { AgentProfile, AgentSkill, CreateSkillRequest, UpdateSkillRequest } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { type FC, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { formatResourceSummary } from './SkillSelector';
import { SkillFormDialog } from './SkillFormDialog';

interface SkillListProps {
  skills: AgentSkill[];
  profiles: AgentProfile[];
  loading: boolean;
  error: string | null;
  onCreateSkill: (data: CreateSkillRequest) => Promise<AgentSkill>;
  onUpdateSkill: (skillId: string, data: UpdateSkillRequest) => Promise<AgentSkill>;
  onDeleteSkill: (skillId: string) => Promise<void>;
  projectId: string;
}

export const SkillList: FC<SkillListProps> = ({
  skills,
  profiles,
  loading,
  error,
  onCreateSkill,
  onUpdateSkill,
  onDeleteSkill,
  projectId,
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const editParam = searchParams.get('edit');
  const formOpen = editParam !== null;
  const editingSkill = useMemo(
    () => (editParam && editParam !== 'new' ? skills.find((skill) => skill.id === editParam) ?? null : null),
    [editParam, skills],
  );

  const openForm = (skillId?: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('edit', skillId ?? 'new');
      return next;
    }, { replace: true });
  };
  const closeForm = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('edit');
      return next;
    }, { replace: true });
  };

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (error) return <div className="rounded-sm bg-danger-tint px-3 py-2 text-sm text-danger">{error}</div>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => openForm()}>
          <Plus className="mr-1.5 inline-block h-4 w-4" />
          New Skill
        </Button>
      </div>

      {skills.length === 0 ? (
        <div className="py-8 text-center text-sm text-fg-muted">
          <Zap className="mx-auto mb-2 h-8 w-8 opacity-50" />
          No skills yet. Create one to reuse task instructions and runtime settings.
        </div>
      ) : (
        <div className="grid gap-2">
          {skills.map((skill) => {
            const resourceSummary = formatResourceSummary(skill);
            return (
              <div key={skill.id} className="overflow-hidden rounded-md glass-surface">
                <div className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg-primary">{skill.name}</div>
                    {skill.description && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{skill.description}</p>}
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
                      <span>Mode: {skill.taskMode ?? 'task'}</span>
                      {skill.defaultProfileId && <span>Default profile set</span>}
                      {skill.vmSizeOverride && <span>VM: {skill.vmSizeOverride}</span>}
                      {resourceSummary && <span>{resourceSummary}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => openForm(skill.id)} aria-label={`Edit ${skill.name}`} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2 text-fg-muted hover:bg-surface hover:text-fg-primary">
                      <Pencil className="h-4 w-4" />
                    </button>
                    {deleteId !== skill.id && (
                      <button type="button" onClick={() => setDeleteId(skill.id)} aria-label={`Delete ${skill.name}`} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2 text-fg-muted hover:bg-danger-tint hover:text-danger">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                {deleteId === skill.id && (
                  <div className="flex items-center justify-end gap-2 px-3 pb-3">
                    <span className="mr-auto text-xs text-fg-muted">Delete this skill?</span>
                    <button type="button" onClick={() => setDeleteId(null)} className="min-h-[44px] rounded px-3 py-2 text-xs text-fg-muted hover:text-fg-primary">Cancel</button>
                    <button type="button" onClick={() => void onDeleteSkill(skill.id).then(() => setDeleteId(null))} className="min-h-[44px] rounded bg-danger-tint px-3 py-2 text-xs text-danger hover:bg-danger hover:text-white">Confirm</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SkillFormDialog
        isOpen={formOpen}
        onClose={closeForm}
        skill={editingSkill}
        profiles={profiles}
        onSave={async (data) => {
          if (editingSkill) {
            await onUpdateSkill(editingSkill.id, data as UpdateSkillRequest);
          } else {
            await onCreateSkill(data as CreateSkillRequest);
          }
        }}
        projectId={projectId}
      />
    </div>
  );
};
