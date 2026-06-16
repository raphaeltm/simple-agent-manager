/**
 * Composable Credentials settings page — manages the three primitives:
 * Credentials, Configurations, and Attachments.
 */

import { Alert, Button, Card, Input, Select, StatusBadge } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { ConfigurationSection } from '../components/settings-credentials/ConfigurationSection';
import {
  type CCAttachmentListItem,
  type CCConfigurationListItem,
  type CCCredentialListItem,
  createCCAttachment,
  createCCCredential,
  deleteCCAttachment,
  deleteCCCredential,
  listCCAttachments,
  listCCConfigurations,
  listCCCredentials,
  listProjects,
  updateCCAttachment,
  updateCCCredential,
} from '../lib/api';

const KIND_LABELS: Record<string, string> = {
  'api-key': 'API Key',
  'oauth-token': 'OAuth Token',
  'openai-compatible': 'OpenAI-compatible',
  'cloud-provider': 'Cloud Provider',
  'auth-json': 'Auth JSON',
};

interface ProjectOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Credential CRUD
// ---------------------------------------------------------------------------

function CredentialCard({
  cred,
  onToggle,
  onDelete,
}: {
  cred: CCCredentialListItem;
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-border-default p-3 ${
        cred.isActive ? 'bg-surface' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-fg-primary break-words">{cred.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
            {KIND_LABELS[cred.kind] ?? cred.kind}
          </span>
          {!cred.isActive && <StatusBadge status="stopped" label="Inactive" />}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${cred.isActive ? 'Deactivate' : 'Activate'} credential ${cred.name}`}
          onClick={onToggle}
        >
          {cred.isActive ? 'Deactivate' : 'Activate'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          aria-label={`Delete credential ${cred.name}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function AddCredentialForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('api-key');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await createCCCredential({ name, kind, secret });
      setName('');
      setSecret('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create credential');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + Add credential
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface"
    >
      {formError && (
        <Alert variant="error" onDismiss={() => setFormError(null)}>
          {formError}
        </Alert>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-cred-name" className="text-xs font-medium text-fg-muted">
          Name
        </label>
        <Input
          id="cc-cred-name"
          placeholder="My Anthropic Key"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-cred-kind" className="text-xs font-medium text-fg-muted">
          Kind
        </label>
        <Select id="cc-cred-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-cred-secret" className="text-xs font-medium text-fg-muted">
          Secret
        </label>
        <Input
          id="cc-cred-secret"
          placeholder="sk-..."
          type="password"
          className="font-mono"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={submitting}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Attachment CRUD
// ---------------------------------------------------------------------------

function AttachmentCard({
  att,
  configurations,
  onToggle,
  onDelete,
}: {
  att: CCAttachmentListItem;
  configurations: CCConfigurationListItem[];
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const cfg = configurations.find((c) => c.id === att.configurationId);
  const label = cfg?.name ?? att.configurationId;
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-border-default p-3 ${
        att.isActive ? 'bg-surface' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm text-fg-primary">{label}</span>
        <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
          {att.projectId ? `project: ${att.projectId.slice(0, 8)}…` : 'user default'}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${att.isActive ? 'Deactivate' : 'Activate'} attachment ${label}`}
          onClick={onToggle}
        >
          {att.isActive ? 'Deactivate' : 'Activate'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          aria-label={`Delete attachment ${label}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function AddAttachmentForm({
  configurations,
  projects,
  onCreated,
}: {
  configurations: CCConfigurationListItem[];
  projects: ProjectOption[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [configurationId, setConfigurationId] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [projectId, setProjectId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configurationId) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await createCCAttachment({
        configurationId,
        projectId: scope === 'project' ? projectId : undefined,
      });
      setConfigurationId('');
      setScope('user');
      setProjectId('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create attachment');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + Add attachment
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface"
    >
      {formError && (
        <Alert variant="error" onDismiss={() => setFormError(null)}>
          {formError}
        </Alert>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-att-config" className="text-xs font-medium text-fg-muted">
          Configuration
        </label>
        <Select
          id="cc-att-config"
          value={configurationId}
          onChange={(e) => setConfigurationId(e.target.value)}
          required
        >
          <option value="">Select configuration</option>
          {configurations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-att-scope" className="text-xs font-medium text-fg-muted">
          Attachment target
        </label>
        <Select
          id="cc-att-scope"
          value={scope}
          onChange={(e) => {
            const nextScope = e.target.value === 'project' ? 'project' : 'user';
            setScope(nextScope);
            if (nextScope === 'user') setProjectId('');
          }}
        >
          <option value="user">User default</option>
          <option value="project">Project override</option>
        </Select>
      </div>
      {scope === 'project' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="cc-att-project" className="text-xs font-medium text-fg-muted">
            Project
          </label>
          <Select
            id="cc-att-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            <option value="">Select project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {scope === 'project' && projects.length === 0 && (
        <p className="m-0 text-xs text-fg-muted">
          No projects are available for project-scoped attachments.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={submitting}
          disabled={!configurationId || (scope === 'project' && !projectId)}
        >
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SettingsCredentials() {
  const [credentials, setCredentials] = useState<CCCredentialListItem[]>([]);
  const [configurations, setConfigurations] = useState<CCConfigurationListItem[]>([]);
  const [attachments, setAttachments] = useState<CCAttachmentListItem[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [creds, cfgs, atts, projectData] = await Promise.all([
        listCCCredentials(),
        listCCConfigurations(),
        listCCAttachments(),
        listProjects(100),
      ]);
      setCredentials(creds);
      setConfigurations(cfgs);
      setAttachments(atts);
      setProjects(projectData.projects.map((project) => ({ id: project.id, name: project.name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleMutation = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        loadAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Operation failed');
      }
    },
    [loadAll]
  );

  if (loading) {
    return (
      <p className="text-sm text-fg-muted p-4" role="status" aria-live="polite">
        Loading credentials…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert variant="info">
        This is the advanced view showing the raw composable-credentials primitives. Most users
        should use the{' '}
        <a href="/settings/connections" className="text-accent font-medium">
          Connections
        </a>{' '}
        tab to manage agent and cloud provider credentials through the guided flow.
      </Alert>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Credentials */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-fg-primary">Credentials</h3>
            <p className="text-xs text-fg-muted">
              Named, typed secrets. Agent-agnostic — one key can power many configurations.
            </p>
          </div>
          {credentials.length === 0 && (
            <p className="text-xs text-fg-muted italic">No credentials yet</p>
          )}
          {credentials.map((cred) => (
            <CredentialCard
              key={cred.id}
              cred={cred}
              onToggle={() =>
                handleMutation(() => updateCCCredential(cred.id, { isActive: !cred.isActive }))
              }
              onDelete={() => {
                if (!confirm(`Delete credential "${cred.name}"? This cannot be undone.`))
                  return Promise.resolve();
                return handleMutation(() => deleteCCCredential(cred.id));
              }}
            />
          ))}
          <AddCredentialForm onCreated={loadAll} />
        </div>
      </Card>

      {/* Configurations */}
      <ConfigurationSection
        configurations={configurations}
        credentials={credentials}
        onMutation={handleMutation}
        onCreated={loadAll}
      />

      {/* Attachments */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-fg-primary">Attachments</h3>
            <p className="text-xs text-fg-muted">
              Bind configurations to scopes — user default or project override.
            </p>
          </div>
          {attachments.length === 0 && (
            <p className="text-xs text-fg-muted italic">No attachments yet</p>
          )}
          {attachments.map((att) => (
            <AttachmentCard
              key={att.id}
              att={att}
              configurations={configurations}
              onToggle={() =>
                handleMutation(() => updateCCAttachment(att.id, { isActive: !att.isActive }))
              }
              onDelete={() => {
                const cfg = configurations.find((c) => c.id === att.configurationId);
                const label = cfg?.name ?? att.configurationId;
                if (!confirm(`Delete attachment "${label}"? This cannot be undone.`))
                  return Promise.resolve();
                return handleMutation(() => deleteCCAttachment(att.id));
              }}
            />
          ))}
          <AddAttachmentForm
            configurations={configurations}
            projects={projects}
            onCreated={loadAll}
          />
        </div>
      </Card>
    </div>
  );
}
