/**
 * Composable Credentials settings page — manages the three primitives:
 * Credentials, Configurations, and Attachments.
 */

import { Alert, Card, StatusBadge } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import {
  type CCAttachmentListItem,
  type CCConfigurationListItem,
  type CCCredentialListItem,
  createCCAttachment,
  createCCConfiguration,
  createCCCredential,
  deleteCCAttachment,
  deleteCCConfiguration,
  deleteCCCredential,
  listCCAttachments,
  listCCConfigurations,
  listCCCredentials,
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

// ---------------------------------------------------------------------------
// Credential CRUD
// ---------------------------------------------------------------------------

function CredentialCard({
  cred,
  onToggle,
  onDelete,
}: {
  cred: CCCredentialListItem;
  onToggle: () => void;
  onDelete: () => void;
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
      <div className="flex gap-2 text-xs">
        <button className="text-fg-muted hover:text-fg-primary" onClick={onToggle}>
          {cred.isActive ? 'Deactivate' : 'Activate'}
        </button>
        <button className="text-red-400 hover:text-red-300" onClick={onDelete}>
          Delete
        </button>
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createCCCredential({ name, kind, secret });
      setName('');
      setSecret('');
      setOpen(false);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        className="text-sm text-brand-primary hover:underline"
        onClick={() => setOpen(true)}
      >
        + Add credential
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface">
      <input
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary"
        placeholder="Name (e.g. My Anthropic Key)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <select
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        {Object.entries(KIND_LABELS).map(([k, label]) => (
          <option key={k} value={k}>{label}</option>
        ))}
      </select>
      <input
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary font-mono"
        placeholder="Secret / token"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        required
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-brand-primary px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          className="text-sm text-fg-muted hover:text-fg-primary"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Configuration CRUD
// ---------------------------------------------------------------------------

function ConfigurationCard({
  cfg,
  credentials,
  onDelete,
}: {
  cfg: CCConfigurationListItem;
  credentials: CCCredentialListItem[];
  onDelete: () => void;
}) {
  const cred = credentials.find((c) => c.id === cfg.credentialId);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-default p-3 bg-surface">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-fg-primary break-words">{cfg.name}</span>
        <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
          {cfg.consumerKind}:{cfg.consumerTarget}
        </span>
      </div>
      <div className="text-xs text-fg-muted">
        Credential: {cred ? cred.name : cfg.credentialId ? '(missing)' : '(none)'}
      </div>
      {cfg.settingsJson && (
        <pre className="text-xs text-fg-muted font-mono bg-bg-primary rounded p-2 overflow-x-auto">
          {cfg.settingsJson}
        </pre>
      )}
      <button className="text-xs text-red-400 hover:text-red-300 self-start" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function AddConfigurationForm({
  credentials,
  onCreated,
}: {
  credentials: CCCredentialListItem[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [consumerKind, setConsumerKind] = useState('agent');
  const [consumerTarget, setConsumerTarget] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createCCConfiguration({
        name,
        consumerKind,
        consumerTarget,
        credentialId: credentialId || undefined,
      });
      setName('');
      setConsumerTarget('');
      setCredentialId('');
      setOpen(false);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        className="text-sm text-brand-primary hover:underline"
        onClick={() => setOpen(true)}
      >
        + Add configuration
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface">
      <input
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <div className="flex gap-2">
        <select
          className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary flex-1"
          value={consumerKind}
          onChange={(e) => setConsumerKind(e.target.value)}
        >
          <option value="agent">Agent</option>
          <option value="compute">Compute</option>
        </select>
        <input
          className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary flex-1"
          placeholder={consumerKind === 'agent' ? 'claude-code' : 'hetzner'}
          value={consumerTarget}
          onChange={(e) => setConsumerTarget(e.target.value)}
          required
        />
      </div>
      <select
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary"
        value={credentialId}
        onChange={(e) => setCredentialId(e.target.value)}
      >
        <option value="">(none)</option>
        {credentials.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-brand-primary px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          className="text-sm text-fg-muted hover:text-fg-primary"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
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
  onToggle: () => void;
  onDelete: () => void;
}) {
  const cfg = configurations.find((c) => c.id === att.configurationId);
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-border-default p-3 ${
        att.isActive ? 'bg-surface' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm text-fg-primary">
          {cfg?.name ?? att.configurationId}
        </span>
        <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
          {att.projectId ? `project: ${att.projectId.slice(0, 8)}…` : 'user default'}
        </span>
      </div>
      <div className="flex gap-2 text-xs">
        <button className="text-fg-muted hover:text-fg-primary" onClick={onToggle}>
          {att.isActive ? 'Deactivate' : 'Activate'}
        </button>
        <button className="text-red-400 hover:text-red-300" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function AddAttachmentForm({
  configurations,
  onCreated,
}: {
  configurations: CCConfigurationListItem[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [configurationId, setConfigurationId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configurationId) return;
    setSubmitting(true);
    try {
      await createCCAttachment({
        configurationId,
        projectId: projectId || undefined,
      });
      setConfigurationId('');
      setProjectId('');
      setOpen(false);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        className="text-sm text-brand-primary hover:underline"
        onClick={() => setOpen(true)}
      >
        + Add attachment
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface">
      <select
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary"
        value={configurationId}
        onChange={(e) => setConfigurationId(e.target.value)}
        required
      >
        <option value="">Select configuration</option>
        {configurations.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <input
        className="rounded border border-border-default bg-bg-primary px-3 py-1.5 text-sm text-fg-primary"
        placeholder="Project ID (leave blank for user default)"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || !configurationId}
          className="rounded bg-brand-primary px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          className="text-sm text-fg-muted hover:text-fg-primary"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [creds, cfgs, atts] = await Promise.all([
        listCCCredentials(),
        listCCConfigurations(),
        listCCAttachments(),
      ]);
      setCredentials(creds);
      setConfigurations(cfgs);
      setAttachments(atts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (loading) {
    return <p className="text-sm text-fg-muted p-4">Loading credentials…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {/* Credentials */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">Credentials</h3>
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
              onToggle={async () => {
                await updateCCCredential(cred.id, { isActive: !cred.isActive });
                loadAll();
              }}
              onDelete={async () => {
                await deleteCCCredential(cred.id);
                loadAll();
              }}
            />
          ))}
          <AddCredentialForm onCreated={loadAll} />
        </div>
      </Card>

      {/* Configurations */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">Configurations</h3>
            <p className="text-xs text-fg-muted">
              Consumer + credential binding. Links a credential to an agent or compute provider.
            </p>
          </div>
          {configurations.length === 0 && (
            <p className="text-xs text-fg-muted italic">No configurations yet</p>
          )}
          {configurations.map((cfg) => (
            <ConfigurationCard
              key={cfg.id}
              cfg={cfg}
              credentials={credentials}
              onDelete={async () => {
                await deleteCCConfiguration(cfg.id);
                loadAll();
              }}
            />
          ))}
          <AddConfigurationForm credentials={credentials} onCreated={loadAll} />
        </div>
      </Card>

      {/* Attachments */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">Attachments</h3>
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
              onToggle={async () => {
                await updateCCAttachment(att.id, { isActive: !att.isActive });
                loadAll();
              }}
              onDelete={async () => {
                await deleteCCAttachment(att.id);
                loadAll();
              }}
            />
          ))}
          <AddAttachmentForm configurations={configurations} onCreated={loadAll} />
        </div>
      </Card>
    </div>
  );
}
