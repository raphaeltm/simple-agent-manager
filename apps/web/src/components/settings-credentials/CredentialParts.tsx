/**
 * Advanced settings → Credentials: one card per raw credential, and the add form.
 */
import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { Alert, Button, Input, Select, StatusBadge } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { type CCCredentialListItem, createCCCredential } from '../../lib/api';
import { formatSampledAgo } from '../credential-limits/credential-limit-format';
import { CredentialLimitChip } from '../credential-limits/CredentialLimitChip';

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

export function CredentialCard({
  cred,
  usage,
  onToggle,
  onDelete,
}: {
  cred: CCCredentialListItem;
  /** Latest provider usage windows SAM observed for this credential, when any. */
  usage: CredentialLimitCredentialSummary | null;
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
        <span className="min-w-0 text-sm font-semibold text-fg-primary break-words [overflow-wrap:anywhere]">
          {cred.name}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
            {KIND_LABELS[cred.kind] ?? cred.kind}
          </span>
          {!cred.isActive && <StatusBadge status="stopped" label="Inactive" />}
        </div>
      </div>
      {usage && usage.windows.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-fg-muted"
          data-testid="credential-usage-row"
        >
          <CredentialLimitChip credential={usage} />
          <span>{formatSampledAgo(usage.observedAt, Date.now())}</span>
        </div>
      )}
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

export function AddCredentialForm({ onCreated }: { onCreated: () => void }) {
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
