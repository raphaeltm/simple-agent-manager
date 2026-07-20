import type {
  AgentEffort,
  AgentProfile,
  AgentProfileRuntime,
  CreateAgentProfileRequest,
  GitHubCliPermissionLevel,
  GitHubCliPolicy,
  ProviderCatalog,
  UpdateAgentProfileRequest,
  VMSize,
} from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  AGENT_PERMISSION_MODE_LABELS,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_GITHUB_CLI_POLICY,
  getSupportedEffortsForAgent,
  isAgentEffortSupported,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import { Button, Dialog, Input } from '@simple-agent-manager/ui';
import { type FC, type ReactNode, useEffect, useState } from 'react';

import { getProject, getProviderCatalog } from '../../lib/api';
import { ModelSelect } from '../ModelSelect';
import {
  formatProviderCatalogContext,
  formatVmSizeOption,
  selectProviderCatalog,
} from '../vm/format-vm-size';
import { ProfileRuntimeSection } from './ProfileRuntimeSection';

/** Default agent type derived from the catalog — avoids hardcoding 'claude-code' */
const DEFAULT_AGENT_TYPE = AGENT_CATALOG[0]!.id;

interface ProfileFormDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** If provided, the form is in edit mode. Otherwise create mode. */
  profile?: AgentProfile | null;
  onSave: (data: CreateAgentProfileRequest | UpdateAgentProfileRequest) => Promise<void>;
  /** Required for loading profile runtime assets in edit mode. */
  projectId: string;
}

const PERMISSION_MODES = [
  { value: '', label: 'No override' },
  ...VALID_PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: AGENT_PERMISSION_MODE_LABELS[mode] ?? mode,
  })),
];

const EFFORT_LABELS: Record<AgentEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const VM_SIZES = [
  { value: '', label: 'Default' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const;

const RUNTIMES = [
  { value: '', label: 'Auto' },
  { value: 'cf-container', label: 'Instant container' },
  { value: 'vm', label: 'Cloud VM' },
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

const GITHUB_PERMISSION_OPTIONS = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and write' },
] as const;

const GITHUB_CONTENTS_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and write' },
] as const;

const GITHUB_PERMISSION_ROWS = [
  { key: 'contents', label: 'Code contents', options: GITHUB_CONTENTS_OPTIONS },
  { key: 'pullRequests', label: 'Pull requests', options: GITHUB_PERMISSION_OPTIONS },
  { key: 'issues', label: 'Issues', options: GITHUB_PERMISSION_OPTIONS },
  { key: 'actions', label: 'Actions', options: GITHUB_PERMISSION_OPTIONS },
  { key: 'packages', label: 'Packages', options: GITHUB_PERMISSION_OPTIONS },
] as const;

// ---------------------------------------------------------------------------
// Reusable form primitives
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, summary, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-border-default">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-3 text-left"
        aria-expanded={open}
      >
        <svg
          className={`h-4 w-4 shrink-0 text-fg-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L9.44 8 6.22 4.78a.75.75 0 0 1 0-1.06Z" />
        </svg>
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">{title}</span>
        {!open && summary && (
          <span className="ml-auto text-xs text-fg-muted truncate max-w-[60%] text-right">
            {summary}
          </span>
        )}
      </button>
      <div className={open ? 'pb-3 grid gap-3' : 'hidden'}>{children}</div>
    </div>
  );
}

const SELECT_CLASSES = 'w-full rounded-md text-fg-primary py-2.5 px-3 min-h-11';

interface SelectFieldProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: readonly { readonly value: string; readonly label: string }[];
  disabled?: boolean;
}

function SelectField({ label, value, onChange, options, disabled }: SelectFieldProps) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm text-fg-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={SELECT_CLASSES}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function agentSettingsSummary(
  agentType: string,
  model: string,
  effort: AgentEffort,
  permissionMode: string,
  timeoutMinutes: string,
): string {
  const parts: string[] = [];
  const agentName = AGENT_CATALOG.find((a) => a.id === agentType)?.name ?? agentType;
  parts.push(agentName);
  if (model) {
    const short = model.length > 24 ? model.slice(0, 22) + '...' : model;
    parts.push(short);
  }
  if (effort !== DEFAULT_AGENT_EFFORT) {
    parts.push(`Effort: ${EFFORT_LABELS[effort]}`);
  }
  if (permissionMode) {
    parts.push(
      (AGENT_PERMISSION_MODE_LABELS as Record<string, string>)[permissionMode] ?? permissionMode,
    );
  }
  if (timeoutMinutes) parts.push(`${timeoutMinutes}m`);
  return parts.join(' · ');
}

function permTag(label: string, level: GitHubCliPermissionLevel): string | null {
  if (level === 'none') return null;
  return `${label}:${level === 'write' ? 'rw' : 'r'}`;
}

function policySummary(policy: GitHubCliPolicy): string {
  if (policy.mode === 'inherit') return 'Inherit installation permissions';
  const p = policy.permissions;
  const tags = [
    permTag('code', p.contents),
    permTag('PRs', p.pullRequests),
    permTag('issues', p.issues),
    permTag('actions', p.actions),
    permTag('pkg', p.packages),
  ].filter(Boolean);
  return `Custom: ${tags.join(', ')}`;
}

function joinOrDefault(parts: (string | false | null | undefined)[], sep = ', '): string {
  const filtered = parts.filter(Boolean) as string[];
  return filtered.length ? filtered.join(sep) : 'Defaults';
}

function executionSummary(maxTurns: string, systemPromptAppend: string): string {
  return joinOrDefault([maxTurns && `${maxTurns} turns`, systemPromptAppend.trim() && 'custom prompt']);
}

function runtimeSummary(runtime: string): string | false {
  if (runtime === 'cf-container') return 'Instant container';
  if (runtime === 'vm') return 'Cloud VM';
  return false;
}

function infraSummary(vmSize: string, workspaceProfile: string, taskMode: string, runtime: string): string {
  return joinOrDefault([runtimeSummary(runtime), vmSize && `${vmSize} VM`, workspaceProfile, taskMode], ' · ');
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const ProfileFormDialog: FC<ProfileFormDialogProps> = ({
  isOpen,
  onClose,
  profile,
  onSave,
  projectId,
}) => {
  const isEdit = !!profile;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<string>(DEFAULT_AGENT_TYPE);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<AgentEffort>(DEFAULT_AGENT_EFFORT);
  const [permissionMode, setPermissionMode] = useState('');
  const [systemPromptAppend, setSystemPromptAppend] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [timeoutMinutes, setTimeoutMinutes] = useState('');
  const [runtime, setRuntime] = useState('');
  const [vmSizeOverride, setVmSizeOverride] = useState('');
  const [workspaceProfile, setWorkspaceProfile] = useState('');
  const [devcontainerConfigName, setDevcontainerConfigName] = useState('');
  const [taskMode, setTaskMode] = useState('');
  const [githubCliPolicy, setGithubCliPolicy] =
    useState<GitHubCliPolicy>(DEFAULT_GITHUB_CLI_POLICY);
  const [catalogs, setCatalogs] = useState<ProviderCatalog[]>([]);
  const [projectProvider, setProjectProvider] = useState<string | null>(null);
  const [projectLocation, setProjectLocation] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when opening/closing or when profile changes
  useEffect(() => {
    if (isOpen && profile) {
      const profileRuntime = profile.runtime ?? '';
      setName(profile.name);
      setDescription(profile.description ?? '');
      setAgentType(profile.agentType);
      setModel(profile.model ?? '');
      setEffort(profile.effort ?? DEFAULT_AGENT_EFFORT);
      setPermissionMode(profile.permissionMode ?? '');
      setSystemPromptAppend(profile.systemPromptAppend ?? '');
      setMaxTurns(profile.maxTurns != null ? String(profile.maxTurns) : '');
      setTimeoutMinutes(profile.timeoutMinutes != null ? String(profile.timeoutMinutes) : '');
      setRuntime(profileRuntime);
      setVmSizeOverride(profileRuntime === 'cf-container' ? '' : profile.vmSizeOverride ?? '');
      setWorkspaceProfile(profileRuntime === 'cf-container' ? 'lightweight' : profile.workspaceProfile ?? '');
      setDevcontainerConfigName(profileRuntime === 'cf-container' ? '' : profile.devcontainerConfigName ?? '');
      setTaskMode(profileRuntime === 'cf-container' ? 'conversation' : profile.taskMode ?? '');
      setGithubCliPolicy(profile.githubCliPolicy ?? DEFAULT_GITHUB_CLI_POLICY);
    } else if (isOpen) {
      setName('');
      setDescription('');
      setAgentType(DEFAULT_AGENT_TYPE);
      setModel('');
      setEffort(DEFAULT_AGENT_EFFORT);
      setPermissionMode('');
      setSystemPromptAppend('');
      setMaxTurns('');
      setTimeoutMinutes('');
      setRuntime('');
      setVmSizeOverride('');
      setWorkspaceProfile('');
      setDevcontainerConfigName('');
      setTaskMode('');
      setGithubCliPolicy(DEFAULT_GITHUB_CLI_POLICY);
    }
    setError(null);
  }, [isOpen, profile]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    Promise.all([getProviderCatalog(), getProject(projectId)])
      .then(([catalogResponse, project]) => {
        if (cancelled) return;
        setCatalogs(Array.isArray(catalogResponse.catalogs) ? catalogResponse.catalogs : []);
        setProjectProvider(project.defaultProvider ?? null);
        setProjectLocation(project.defaultLocation ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogs([]);
          setProjectProvider(null);
          setProjectLocation(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

  const effectiveProvider = profile?.provider ?? projectProvider;
  const activeCatalog = selectProviderCatalog(catalogs, effectiveProvider);
  const effectiveLocation =
    profile?.vmLocation ?? projectLocation ?? activeCatalog?.defaultLocation ?? null;
  const providerContext = formatProviderCatalogContext(activeCatalog, effectiveLocation);
  const effortOptions = getSupportedEffortsForAgent(agentType).map((value) => ({
    value,
    label: EFFORT_LABELS[value],
  }));

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
        effort,
        permissionMode: permissionMode || null,
        systemPromptAppend: systemPromptAppend.trim() || null,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
        timeoutMinutes: timeoutMinutes ? parseInt(timeoutMinutes, 10) : null,
        runtime: runtime ? (runtime as AgentProfileRuntime) : null,
        vmSizeOverride: vmSizeOverride || null,
        workspaceProfile: workspaceProfile || null,
        devcontainerConfigName:
          workspaceProfile !== 'lightweight' ? devcontainerConfigName.trim() || null : null,
        taskMode: taskMode || null,
        githubCliPolicy: githubCliPolicy.mode === 'custom' ? githubCliPolicy : null,
      };
      await onSave(data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const updateGitHubPermission = (
    key: keyof GitHubCliPolicy['permissions'],
    value: GitHubCliPermissionLevel
  ) => {
    setGithubCliPolicy((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        [key]: value,
      },
    }));
  };

  const handleRuntimeChange = (value: string) => {
    setRuntime(value);
    if (value === 'cf-container') {
      setVmSizeOverride('');
      setWorkspaceProfile('lightweight');
      setDevcontainerConfigName('');
      setTaskMode('conversation');
    }
  };

  const isInstantRuntime = runtime === 'cf-container';

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <h2 id="dialog-title" className="text-lg font-semibold text-fg-primary mb-4">
          {isEdit ? 'Edit Profile' : 'Create Agent Profile'}
        </h2>

        {error && (
          <div
            role="alert"
            className="py-2 px-3 mb-3 rounded-sm bg-danger-tint text-danger text-sm"
          >
            {error}
          </div>
        )}

        {/* Name & Description — always visible */}
        <div className="grid gap-3">
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

          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Description</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              placeholder="What this profile is for..."
              disabled={saving}
            />
          </label>
        </div>

        {/* --- Accordion sections --- */}

        <Section
          title="Agent Settings"
          defaultOpen
          summary={agentSettingsSummary(agentType, model, effort, permissionMode, timeoutMinutes)}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Agent Type"
              value={agentType}
              onChange={(v) => {
                setAgentType(v);
                setModel('');
                setEffort((current) =>
                  isAgentEffortSupported(v, current) ? current : DEFAULT_AGENT_EFFORT,
                );
              }}
              options={AGENT_CATALOG.map((a) => ({ value: a.id, label: a.name }))}
              disabled={saving}
            />

            <div className="grid gap-1.5">
              <label htmlFor="profile-model" className="text-sm text-fg-muted">
                Model
              </label>
              <ModelSelect
                id="profile-model"
                agentType={agentType}
                value={model}
                onChange={setModel}
                disabled={saving}
                placeholder="Select or type a model..."
              />
            </div>

            <SelectField
              label="Effort"
              value={effort}
              onChange={(v) => setEffort(v as AgentEffort)}
              options={effortOptions}
              disabled={saving}
            />

            <SelectField
              label="Permission Mode"
              value={permissionMode}
              onChange={setPermissionMode}
              options={PERMISSION_MODES}
              disabled={saving}
            />

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
        </Section>

        <Section
          title="Platform Policy"
          summary={policySummary(githubCliPolicy)}
        >
          <div className="grid gap-3">
            <SelectField
              label="GitHub CLI access"
              value={githubCliPolicy.mode}
              onChange={(mode) =>
                setGithubCliPolicy((current) => ({
                  ...(current ?? DEFAULT_GITHUB_CLI_POLICY),
                  mode: mode as GitHubCliPolicy['mode'],
                  repositoryScope: 'project',
                }))
              }
              options={[
                { value: 'inherit', label: 'Inherit GitHub App installation permissions' },
                { value: 'custom', label: 'Restrict token minted for this profile' },
              ]}
              disabled={saving}
            />

            {githubCliPolicy.mode === 'custom' && (
              <fieldset className="grid gap-2 rounded-md border border-border-default p-3">
                <legend className="px-1 text-sm font-medium text-fg-primary">
                  Project repository token permissions
                </legend>
                <p className="m-0 text-xs text-fg-muted">
                  These permissions apply to the project&rsquo;s selected repository set &mdash; the
                  primary repository plus any additional repositories added under Repository Access
                  &mdash; not only the primary repo. The token is narrowed to that set before each
                  mint. Code contents must stay readable so the workspace can clone and fetch the
                  repositories.
                </p>
                {GITHUB_PERMISSION_ROWS.map((row) => (
                  <label
                    key={row.key}
                    className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
                  >
                    <span className="text-sm text-fg-primary">{row.label}</span>
                    <select
                      value={githubCliPolicy.permissions[row.key]}
                      onChange={(e) =>
                        updateGitHubPermission(row.key, e.target.value as GitHubCliPermissionLevel)
                      }
                      disabled={saving}
                      className={SELECT_CLASSES}
                    >
                      {row.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        </Section>

        <Section
          title="Execution"
          summary={executionSummary(maxTurns, systemPromptAppend)}
        >
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

          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">System Prompt (append)</span>
            <textarea
              value={systemPromptAppend}
              onChange={(e) => setSystemPromptAppend(e.target.value)}
              placeholder="Additional instructions appended to the system prompt..."
              rows={3}
              disabled={saving}
              className="w-full rounded-md text-fg-primary py-2.5 px-3 resize-y"
            />
          </label>
        </Section>

        <Section
          title="Infrastructure"
          summary={infraSummary(vmSizeOverride, workspaceProfile, taskMode, runtime)}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Runtime"
              value={runtime}
              onChange={handleRuntimeChange}
              options={RUNTIMES}
              disabled={saving}
            />

            <SelectField
              label={<>VM Size{providerContext && <span className="font-normal ml-1">({providerContext})</span>}</>}
              value={vmSizeOverride}
              onChange={setVmSizeOverride}
              options={VM_SIZES.map((vs) => ({
                value: vs.value,
                label: vs.value
                  ? formatVmSizeOption(vs.value as VMSize, activeCatalog?.sizes[vs.value as VMSize] ?? null)
                  : vs.label,
              }))}
              disabled={saving || isInstantRuntime}
            />

            <SelectField
              label="Workspace Profile"
              value={workspaceProfile}
              onChange={setWorkspaceProfile}
              options={WORKSPACE_PROFILES}
              disabled={saving || isInstantRuntime}
            />

            {!isInstantRuntime && workspaceProfile !== 'lightweight' && (
              <label className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Devcontainer Config</span>
                <Input
                  value={devcontainerConfigName}
                  onChange={(e) => setDevcontainerConfigName(e.target.value)}
                  disabled={saving}
                  placeholder="Auto-detect"
                />
              </label>
            )}

            <SelectField
              label="Task Mode"
              value={taskMode}
              onChange={setTaskMode}
              options={TASK_MODES}
              disabled={saving || isInstantRuntime}
            />
          </div>
        </Section>

        {/* Runtime Environment (edit mode only) */}
        {isEdit && profile && (
          <Section title="Runtime Environment" summary="Env vars and files">
            <ProfileRuntimeSection projectId={projectId} profileId={profile.id} />
          </Section>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-4 pt-3 border-t border-border-default justify-end">
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
