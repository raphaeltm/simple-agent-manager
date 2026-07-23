import { AGENT_CATALOG, CREDENTIAL_PROVIDERS } from '@simple-agent-manager/shared';
import { Alert, Button, Card, Input, Select, StatusBadge } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import type { CCConfigurationListItem, CCCredentialListItem } from '../../lib/api';
import { createCCConfiguration, deleteCCConfiguration, updateCCConfiguration } from '../../lib/api';

const COMPUTE_LABELS: Record<string, string> = {
  hetzner: 'Hetzner Cloud',
  scaleway: 'Scaleway',
  gcp: 'Google Cloud (GCP)',
  vultr: 'Vultr',
};

interface ConfigurationSectionProps {
  configurations: CCConfigurationListItem[];
  credentials: CCCredentialListItem[];
  onMutation: (action: () => Promise<unknown>) => Promise<void>;
  onCreated: () => void;
}

export function ConfigurationSection({
  configurations,
  credentials,
  onMutation,
  onCreated,
}: ConfigurationSectionProps) {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-fg-primary">Configurations</h3>
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
            onUpdate={(body) => onMutation(() => updateCCConfiguration(cfg.id, body))}
            onDelete={() => {
              if (!confirm(`Delete configuration "${cfg.name}"? This cannot be undone.`)) {
                return Promise.resolve();
              }
              return onMutation(() => deleteCCConfiguration(cfg.id));
            }}
          />
        ))}
        <AddConfigurationForm credentials={credentials} onCreated={onCreated} />
      </div>
    </Card>
  );
}

function getConsumerOptions(consumerKind: string): Array<{ value: string; label: string }> {
  if (consumerKind === 'compute') {
    return CREDENTIAL_PROVIDERS.map((provider) => ({
      value: provider,
      label: COMPUTE_LABELS[provider] ?? provider,
    }));
  }

  return AGENT_CATALOG.map((agent) => ({
    value: agent.id,
    label: agent.name,
  }));
}

function ConfigurationCard({
  cfg,
  credentials,
  onUpdate,
  onDelete,
}: {
  cfg: CCConfigurationListItem;
  credentials: CCCredentialListItem[];
  onUpdate: (body: {
    name?: string;
    credentialId?: string | null;
    isActive?: boolean;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const cred = credentials.find((c) => c.id === cfg.credentialId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cfg.name);
  const [credentialId, setCredentialId] = useState(cfg.credentialId ?? '');
  const [isActive, setIsActive] = useState(cfg.isActive);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setName(cfg.name);
    setCredentialId(cfg.credentialId ?? '');
    setIsActive(cfg.isActive);
  }, [cfg]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await onUpdate({
        name,
        credentialId: credentialId || null,
        isActive,
      });
      setEditing(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update configuration');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form
        onSubmit={(e) => void handleSave(e)}
        className="flex flex-col gap-3 rounded-md border border-border-default p-3 bg-surface"
      >
        {formError && (
          <Alert variant="error" onDismiss={() => setFormError(null)}>
            {formError}
          </Alert>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={`cc-cfg-edit-name-${cfg.id}`} className="text-xs font-medium text-fg-muted">
            Name
          </label>
          <Input
            id={`cc-cfg-edit-name-${cfg.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`cc-cfg-edit-credential-${cfg.id}`}
            className="text-xs font-medium text-fg-muted"
          >
            Credential
          </label>
          <Select
            id={`cc-cfg-edit-credential-${cfg.id}`}
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
          >
            <option value="">(none)</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs text-fg-muted cursor-pointer">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.currentTarget.checked)}
          />
          Active
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              setName(cfg.name);
              setCredentialId(cfg.credentialId ?? '');
              setIsActive(cfg.isActive);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-border-default p-3 ${
        cfg.isActive ? 'bg-surface' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-fg-primary break-words">{cfg.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
            {cfg.consumerKind === 'agent' ? 'Agent' : 'Compute'}: {cfg.consumerTarget}
          </span>
          {!cfg.isActive && <StatusBadge status="stopped" label="Inactive" />}
        </div>
      </div>
      <div className="text-xs text-fg-muted">
        Credential: {cred ? cred.name : cfg.credentialId ? '(missing)' : '(none)'}
      </div>
      {cfg.settingsJson && (
        <pre
          className="text-xs text-fg-muted font-mono bg-bg-primary rounded p-2 overflow-x-auto"
          aria-label="Configuration settings JSON"
        >
          {cfg.settingsJson}
        </pre>
      )}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit configuration ${cfg.name}`}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
        <Button
          variant="danger"
          size="sm"
          aria-label={`Delete configuration ${cfg.name}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
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
  const [consumerTarget, setConsumerTarget] = useState(getConsumerOptions('agent')[0]?.value ?? '');
  const [credentialId, setCredentialId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const consumerOptions = getConsumerOptions(consumerKind);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await createCCConfiguration({
        name,
        consumerKind,
        consumerTarget,
        credentialId: credentialId || undefined,
      });
      setName('');
      setConsumerTarget(getConsumerOptions(consumerKind)[0]?.value ?? '');
      setCredentialId('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create configuration');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + Add configuration
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
        <label htmlFor="cc-cfg-name" className="text-xs font-medium text-fg-muted">
          Name
        </label>
        <Input
          id="cc-cfg-name"
          placeholder="Claude Code config"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex flex-col gap-1 flex-1">
          <label htmlFor="cc-cfg-consumer-kind" className="text-xs font-medium text-fg-muted">
            Consumer type
          </label>
          <Select
            id="cc-cfg-consumer-kind"
            value={consumerKind}
            onChange={(e) => {
              const nextKind = e.target.value;
              setConsumerKind(nextKind);
              setConsumerTarget(getConsumerOptions(nextKind)[0]?.value ?? '');
            }}
          >
            <option value="agent">Agent</option>
            <option value="compute">Compute</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <label htmlFor="cc-cfg-consumer-target" className="text-xs font-medium text-fg-muted">
            Target
          </label>
          <Select
            id="cc-cfg-consumer-target"
            value={consumerTarget}
            onChange={(e) => setConsumerTarget(e.target.value)}
            required
          >
            {consumerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cc-cfg-credential" className="text-xs font-medium text-fg-muted">
          Credential
        </label>
        <Select
          id="cc-cfg-credential"
          value={credentialId}
          onChange={(e) => setCredentialId(e.target.value)}
        >
          <option value="">(none)</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
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
