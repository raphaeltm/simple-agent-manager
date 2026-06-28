import type { AgentProfile, AgentSkill, CreateSkillRequest, UpdateSkillRequest } from '@simple-agent-manager/shared';
import { Button, Dialog, Input } from '@simple-agent-manager/ui';
import { type FC, useMemo, useState } from 'react';

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

function parseResourceRequirements(json: string | null | undefined): {
  minVcpu: string;
  minMemoryGb: string;
  minDiskGb: string;
  exclusiveNode: boolean;
  maxCoTenants: string;
} {
  if (json) {
    try {
      const req = JSON.parse(json) as Record<string, unknown>;
      return {
        minVcpu: typeof req.minVcpu === 'number' ? String(req.minVcpu) : '',
        minMemoryGb: typeof req.minMemoryGb === 'number' ? String(req.minMemoryGb) : '',
        minDiskGb: typeof req.minDiskGb === 'number' ? String(req.minDiskGb) : '',
        exclusiveNode: req.exclusiveNode === true,
        maxCoTenants: typeof req.maxCoTenants === 'number' ? String(req.maxCoTenants) : '',
      };
    } catch {
      // fall through
    }
  }
  return { minVcpu: '', minMemoryGb: '', minDiskGb: '', exclusiveNode: false, maxCoTenants: '' };
}

export const SkillFormDialog: FC<SkillFormDialogProps> = ({
  isOpen,
  onClose,
  skill,
  profiles,
  onSave,
  projectId,
}) => {
  // Key the form body so it remounts with fresh state when the dialog opens
  // or the skill changes, removing the need for a prop-to-state sync effect.
  const formKey = useMemo(
    () => (isOpen ? `${skill?.id ?? 'new'}-${Date.now()}` : 'closed'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOpen, skill?.id],
  );

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="lg">
      {isOpen && (
        <SkillFormBody
          key={formKey}
          skill={skill ?? null}
          profiles={profiles}
          onSave={onSave}
          onClose={onClose}
          projectId={projectId}
        />
      )}
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Inner form body — remounted via key. All form state is initialized from the
// skill prop; no sync effect needed.
// ---------------------------------------------------------------------------

const SkillFormBody: FC<{
  skill: AgentSkill | null;
  profiles: AgentProfile[];
  onSave: (data: CreateSkillRequest | UpdateSkillRequest) => Promise<void>;
  onClose: () => void;
  projectId: string;
}> = ({ skill, profiles, onSave, onClose, projectId }) => {
  const isEdit = !!skill;
  const initialResources = parseResourceRequirements(skill?.resourceRequirementsJson);
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [defaultProfileId, setDefaultProfileId] = useState(skill?.defaultProfileId ?? '');
  const [systemPromptAppend, setSystemPromptAppend] = useState(skill?.systemPromptAppend ?? '');
  const [vmSizeOverride, setVmSizeOverride] = useState(skill?.vmSizeOverride ?? '');
  const [taskMode, setTaskMode] = useState(skill?.taskMode ?? 'task');
  const [minVcpu, setMinVcpu] = useState(initialResources.minVcpu);
  const [minMemoryGb, setMinMemoryGb] = useState(initialResources.minMemoryGb);
  const [minDiskGb, setMinDiskGb] = useState(initialResources.minDiskGb);
  const [exclusiveNode, setExclusiveNode] = useState(initialResources.exclusiveNode);
  const [maxCoTenants, setMaxCoTenants] = useState(initialResources.maxCoTenants);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Skill name is required');
      return;
    }
    // Serialize structured resource fields to JSON
    const req: Record<string, unknown> = {};
    if (minVcpu) req.minVcpu = Number(minVcpu);
    if (minMemoryGb) req.minMemoryGb = Number(minMemoryGb);
    if (minDiskGb) req.minDiskGb = Number(minDiskGb);
    if (exclusiveNode) req.exclusiveNode = true;
    if (maxCoTenants && !exclusiveNode) req.maxCoTenants = Number(maxCoTenants);
    const serialized = Object.keys(req).length > 0 ? JSON.stringify(req) : null;

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
        resourceRequirementsJson: serialized,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  return (
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
          <fieldset className="grid gap-1.5">
            <legend className="text-sm text-fg-muted">Resource Requirements</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <label htmlFor="skill-min-vcpu" className="grid gap-1">
                <span className="text-xs text-fg-muted">Min vCPUs</span>
                <input
                  id="skill-min-vcpu"
                  type="number"
                  min={1}
                  step={1}
                  value={minVcpu}
                  onChange={(e) => setMinVcpu(e.target.value)}
                  placeholder="Default"
                  disabled={saving}
                  className={FIELD_CLASSES}
                />
              </label>
              <label htmlFor="skill-min-memory" className="grid gap-1">
                <span className="text-xs text-fg-muted">Min Memory (GB)</span>
                <input
                  id="skill-min-memory"
                  type="number"
                  min={1}
                  step={1}
                  value={minMemoryGb}
                  onChange={(e) => setMinMemoryGb(e.target.value)}
                  placeholder="Default"
                  disabled={saving}
                  className={FIELD_CLASSES}
                />
              </label>
              <label htmlFor="skill-min-disk" className="grid gap-1">
                <span className="text-xs text-fg-muted">Min Disk (GB)</span>
                <input
                  id="skill-min-disk"
                  type="number"
                  min={1}
                  step={1}
                  value={minDiskGb}
                  onChange={(e) => setMinDiskGb(e.target.value)}
                  placeholder="Default"
                  disabled={saving}
                  className={FIELD_CLASSES}
                />
              </label>
            </div>
            <div className="mt-1 grid gap-3 sm:grid-cols-2">
              <label htmlFor="skill-exclusive-node" className="flex min-h-11 items-center gap-2">
                <input
                  id="skill-exclusive-node"
                  type="checkbox"
                  checked={exclusiveNode}
                  onChange={(e) => setExclusiveNode(e.target.checked)}
                  disabled={saving}
                  className="h-4 w-4 rounded border-border-default accent-[var(--sam-color-focus-ring)]"
                />
                <span className="text-sm text-fg-muted">Exclusive Node</span>
              </label>
              <label htmlFor="skill-max-cotenants" className="grid gap-1">
                <span className="text-xs text-fg-muted">Max Co-tenants</span>
                <input
                  id="skill-max-cotenants"
                  type="number"
                  min={1}
                  step={1}
                  value={exclusiveNode ? '' : maxCoTenants}
                  onChange={(e) => setMaxCoTenants(e.target.value)}
                  placeholder={exclusiveNode ? '1 (exclusive)' : 'Default'}
                  disabled={saving || exclusiveNode}
                  className={FIELD_CLASSES}
                />
              </label>
            </div>
            <span className="text-xs text-fg-muted">
              Optional. Minimum resource constraints for VM selection. Leave blank to use the VM size above.
            </span>
          </fieldset>
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
  );
};
