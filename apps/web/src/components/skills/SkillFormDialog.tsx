import type { AgentProfile, AgentSkill, CreateSkillRequest, UpdateSkillRequest } from '@simple-agent-manager/shared';
import { Button, Dialog, Input } from '@simple-agent-manager/ui';
import { type FC, useEffect, useState } from 'react';

import { SkillRuntimeSection } from './SkillRuntimeSection';

interface SkillFormDialogProps {
  isOpen: boolean;
  onClose: () => void;
  skill?: AgentSkill | null;
  profiles: AgentProfile[];
  onSave: (data: CreateSkillRequest | UpdateSkillRequest) => Promise<void>;
  projectId: string;
}

const FIELD_CLASSES =
  'w-full rounded-md border border-border-default bg-surface px-3 py-2.5 text-fg-primary min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]';

export const SkillFormDialog: FC<SkillFormDialogProps> = ({
  isOpen,
  onClose,
  skill,
  profiles,
  onSave,
  projectId,
}) => {
  const isEdit = !!skill;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultProfileId, setDefaultProfileId] = useState('');
  const [systemPromptAppend, setSystemPromptAppend] = useState('');
  const [vmSizeOverride, setVmSizeOverride] = useState('');
  const [taskMode, setTaskMode] = useState('task');
  const [resourceRequirementsJson, setResourceRequirementsJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(skill?.name ?? '');
    setDescription(skill?.description ?? '');
    setDefaultProfileId(skill?.defaultProfileId ?? '');
    setSystemPromptAppend(skill?.systemPromptAppend ?? '');
    setVmSizeOverride(skill?.vmSizeOverride ?? '');
    setTaskMode(skill?.taskMode ?? 'task');
    setResourceRequirementsJson(skill?.resourceRequirementsJson ?? '');
    setError(null);
  }, [isOpen, skill]);

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Skill name is required');
      return;
    }
    if (resourceRequirementsJson.trim()) {
      try {
        JSON.parse(resourceRequirementsJson);
      } catch {
        setError('Resource requirements must be valid JSON');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        description: description.trim() || null,
        defaultProfileId: defaultProfileId || null,
        systemPromptAppend: systemPromptAppend.trim() || null,
        vmSizeOverride: vmSizeOverride || null,
        taskMode: taskMode || 'task',
        resourceRequirementsJson: resourceRequirementsJson.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <form onSubmit={(event) => { event.preventDefault(); void handleSubmit(); }}>
        <h2 id="dialog-title" className="mb-1 text-lg font-semibold text-fg-primary">
          {isEdit ? 'Edit Skill' : 'Create Skill'}
        </h2>
        <p className="mb-4 text-xs text-fg-muted">
          Skills layer reusable settings on top of an agent profile. When selected, a skill&apos;s
          values override the profile, project, and platform defaults.
        </p>
        {error && (
          <div role="alert" className="mb-3 rounded-sm bg-danger-tint px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="grid gap-3">
          <label htmlFor="skill-name" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Name</span>
            <Input id="skill-name" value={name} onChange={(event) => setName(event.currentTarget.value)} disabled={saving} />
          </label>
          <label htmlFor="skill-description" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Description</span>
            <Input id="skill-description" value={description} onChange={(event) => setDescription(event.currentTarget.value)} disabled={saving} />
          </label>
          <label htmlFor="skill-default-profile" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Default Profile</span>
            <select
              id="skill-default-profile"
              value={defaultProfileId}
              onChange={(event) => setDefaultProfileId(event.target.value)}
              disabled={saving}
              className={FIELD_CLASSES}
            >
              <option value="">No default profile</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
            <span className="text-xs text-fg-muted">
              Used as the base profile when this skill is selected, unless a profile is chosen explicitly at submit time.
            </span>
          </label>
          <label htmlFor="skill-system-prompt" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">System Prompt (append)</span>
            <textarea
              id="skill-system-prompt"
              value={systemPromptAppend}
              onChange={(event) => setSystemPromptAppend(event.target.value)}
              rows={3}
              disabled={saving}
              className={`${FIELD_CLASSES} resize-y`}
            />
            <span className="text-xs text-fg-muted">
              Appended after the profile&apos;s prompt — both are sent to the agent.
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label htmlFor="skill-vm-size" className="grid gap-1.5">
              <span className="text-sm text-fg-muted">VM Size</span>
              <select id="skill-vm-size" value={vmSizeOverride} onChange={(event) => setVmSizeOverride(event.target.value)} disabled={saving} className={FIELD_CLASSES}>
                <option value="">Default</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label htmlFor="skill-task-mode" className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Task Mode</span>
              <select id="skill-task-mode" value={taskMode} onChange={(event) => setTaskMode(event.target.value)} disabled={saving} className={FIELD_CLASSES}>
                <option value="task">Task</option>
                <option value="conversation">Conversation</option>
              </select>
            </label>
          </div>
          <label htmlFor="skill-resource-requirements" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Resource Requirements JSON</span>
            <textarea
              id="skill-resource-requirements"
              value={resourceRequirementsJson}
              onChange={(event) => setResourceRequirementsJson(event.target.value)}
              rows={4}
              placeholder='{"minVcpu":2,"minMemoryGb":4}'
              disabled={saving}
              className={`${FIELD_CLASSES} resize-y font-mono text-sm`}
            />
            <span className="text-xs text-fg-muted">
              Optional. Minimum resource constraints for VM selection. Leave blank to use the VM size above.
            </span>
          </label>
        </div>

        {isEdit && skill ? (
          <div className="mt-4 border-t border-border-default pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Runtime Environment</div>
            <SkillRuntimeSection projectId={projectId} skillId={skill.id} />
          </div>
        ) : (
          <p className="mt-4 border-t border-border-default pt-3 text-xs text-fg-muted">
            After creating the skill, reopen it to add environment variables and runtime files.
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving} disabled={saving}>{isEdit ? 'Save Changes' : 'Create Skill'}</Button>
        </div>
      </form>
    </Dialog>
  );
};
