import { type FC, useState, useEffect } from 'react';
import type { AgentProfile, CreateAgentProfileRequest, UpdateAgentProfileRequest } from '@simple-agent-manager/shared';
import { AGENT_CATALOG, VALID_PERMISSION_MODES, AGENT_PERMISSION_MODE_LABELS } from '@simple-agent-manager/shared';
import { Button, Input, Dialog } from '@simple-agent-manager/ui';

/** Default agent type derived from the catalog — avoids hardcoding 'claude-code' */
const DEFAULT_AGENT_TYPE = AGENT_CATALOG[0]!.id;

interface ProfileFormDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** If provided, the form is in edit mode. Otherwise create mode. */
  profile?: AgentProfile | null;
  onSave: (data: CreateAgentProfileRequest | UpdateAgentProfileRequest) => Promise<void>;
}

const PERMISSION_MODES = [
  { value: '', label: 'No override' },
  ...VALID_PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: AGENT_PERMISSION_MODE_LABELS[mode] ?? mode,
  })),
];

const VM_SIZES = [
  { value: '', label: 'Default' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const;

const WORKSPACE_PROFILES = [
  { value: '', label: 'Default' },
  { value: 'full', label: 'Full' },
  { value: 'lightweight', label: 'Lightweight' },
] as const;

const TASK_MODES = [
  { value: '', label: 'Default' },
  { value: 'task', label: 'Task' },
  { value: 'conversation', label: 'Conversation' },
] as const;

export const ProfileFormDialog: FC<ProfileFormDialogProps> = ({
  isOpen,
  onClose,
  profile,
  onSave,
}) => {
  const isEdit = !!profile;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<string>(DEFAULT_AGENT_TYPE);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [systemPromptAppend, setSystemPromptAppend] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [timeoutMinutes, setTimeoutMinutes] = useState('');
  const [vmSizeOverride, setVmSizeOverride] = useState('');
  const [workspaceProfile, setWorkspaceProfile] = useState('');
  const [taskMode, setTaskMode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when opening/closing or when profile changes
  useEffect(() => {
    if (isOpen && profile) {
      setName(profile.name);
      setDescription(profile.description ?? '');
      setAgentType(profile.agentType);
      setModel(profile.model ?? '');
      setPermissionMode(profile.permissionMode ?? '');
      setSystemPromptAppend(profile.systemPromptAppend ?? '');
      setMaxTurns(profile.maxTurns != null ? String(profile.maxTurns) : '');
      setTimeoutMinutes(profile.timeoutMinutes != null ? String(profile.timeoutMinutes) : '');
      setVmSizeOverride(profile.vmSizeOverride ?? '');
      setWorkspaceProfile(profile.workspaceProfile ?? '');
      setTaskMode(profile.taskMode ?? '');
    } else if (isOpen) {
      setName('');
      setDescription('');
      setAgentType(DEFAULT_AGENT_TYPE);
      setModel('');
      setPermissionMode('');
      setSystemPromptAppend('');
      setMaxTurns('');
      setTimeoutMinutes('');
      setVmSizeOverride('');
      setWorkspaceProfile('');
      setTaskMode('');
    }
    setError(null);
  }, [isOpen, profile]);

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Profile name is required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const data: CreateAgentProfileRequest = {
        name: trimmedName,
        description: description.trim() || null,
        agentType: agentType || DEFAULT_AGENT_TYPE,
        model: model.trim() || null,
        permissionMode: permissionMode || null,
        systemPromptAppend: systemPromptAppend.trim() || null,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
        timeoutMinutes: timeoutMinutes ? parseInt(timeoutMinutes, 10) : null,
        vmSizeOverride: vmSizeOverride || null,
        workspaceProfile: workspaceProfile || null,
        taskMode: taskMode || null,
      };
      await onSave(data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const selectClasses = 'w-full rounded-md border border-border-default bg-surface text-fg-primary py-2.5 px-3 min-h-11';

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <form onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}>
      <h2 id="dialog-title" className="text-lg font-semibold text-fg-primary mb-4">
        {isEdit ? 'Edit Profile' : 'Create Agent Profile'}
      </h2>

      {error && (
        <div role="alert" className="py-2 px-3 mb-3 rounded-sm bg-danger-tint text-danger text-sm">
          {error}
        </div>
      )}

      <div className="grid gap-3">
        {/* Name */}
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">
            Name <span className="text-danger">*</span>
          </span>
          <Input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="e.g. Fast Implementer"
            disabled={saving}
          />
        </label>

        {/* Description */}
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Description</span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="What this profile is for..."
            disabled={saving}
          />
        </label>

        {/* Agent settings section */}
        <div className="border-t border-border-default pt-3 mt-1">
          <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Agent Settings</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Agent Type */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Agent Type</span>
            <select
              value={agentType}
              onChange={(e) => setAgentType(e.target.value)}
              disabled={saving}
              className={selectClasses}
            >
              {AGENT_CATALOG.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>

          {/* Model */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Model</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
              placeholder="e.g. claude-opus-4-6"
              disabled={saving}
            />
          </label>

          {/* Permission Mode */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Permission Mode</span>
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
              disabled={saving}
              className={selectClasses}
            >
              {PERMISSION_MODES.map((pm) => (
                <option key={pm.value} value={pm.value}>
                  {pm.label}
                </option>
              ))}
            </select>
          </label>

          {/* Timeout */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Timeout (minutes)</span>
            <Input
              type="number"
              value={timeoutMinutes}
              onChange={(e) => setTimeoutMinutes(e.currentTarget.value)}
              placeholder="Default"
              disabled={saving}
            />
          </label>
        </div>

        {/* Max Turns */}
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Max Turns</span>
          <Input
            type="number"
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.currentTarget.value)}
            placeholder="Default"
            disabled={saving}
          />
        </label>

        {/* System Prompt Append */}
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">System Prompt (append)</span>
          <textarea
            value={systemPromptAppend}
            onChange={(e) => setSystemPromptAppend(e.target.value)}
            placeholder="Additional instructions appended to the system prompt..."
            rows={3}
            disabled={saving}
            className="w-full rounded-md border border-border-default bg-surface text-fg-primary py-2.5 px-3 resize-y"
          />
        </label>

        {/* Infrastructure section */}
        <div className="border-t border-border-default pt-3 mt-1">
          <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Infrastructure</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* VM Size */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">VM Size</span>
            <select
              value={vmSizeOverride}
              onChange={(e) => setVmSizeOverride(e.target.value)}
              disabled={saving}
              className={selectClasses}
            >
              {VM_SIZES.map((vs) => (
                <option key={vs.value} value={vs.value}>
                  {vs.label}
                </option>
              ))}
            </select>
          </label>

          {/* Workspace Profile */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Workspace Profile</span>
            <select
              value={workspaceProfile}
              onChange={(e) => setWorkspaceProfile(e.target.value)}
              disabled={saving}
              className={selectClasses}
            >
              {WORKSPACE_PROFILES.map((wp) => (
                <option key={wp.value} value={wp.value}>
                  {wp.label}
                </option>
              ))}
            </select>
          </label>

          {/* Task Mode */}
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Task Mode</span>
            <select
              value={taskMode}
              onChange={(e) => setTaskMode(e.target.value)}
              disabled={saving}
              className={selectClasses}
            >
              {TASK_MODES.map((tm) => (
                <option key={tm.value} value={tm.value}>
                  {tm.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-6 justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} loading={saving}>
          {isEdit ? 'Save Changes' : 'Create Profile'}
        </Button>
      </div>
      </form>
    </Dialog>
  );
};
