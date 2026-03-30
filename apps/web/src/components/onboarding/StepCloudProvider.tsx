import { useState } from 'react';
import type { CreateCredentialRequest } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS, PROVIDER_HELP } from '@simple-agent-manager/shared';
import { Button, Input, Alert } from '@simple-agent-manager/ui';
import { createCredential } from '../../lib/api';

type CloudProvider = 'hetzner' | 'scaleway';

interface ProviderOption {
  id: CloudProvider;
  name: string;
  description: string;
  helpUrl: string;
  helpText: string;
}

const PROVIDERS: ProviderOption[] = (['hetzner', 'scaleway'] as const).map((id) => ({
  id,
  name: PROVIDER_LABELS[id] ?? id,
  description: PROVIDER_HELP[id]?.description ?? '',
  helpUrl: PROVIDER_HELP[id]?.helpUrl ?? '',
  helpText: PROVIDER_HELP[id]?.helpText ?? '',
}));

interface StepCloudProviderProps {
  onComplete: () => void;
  onSkip: () => void;
  isComplete: boolean;
}

export function StepCloudProvider({ onComplete, onSkip, isComplete }: StepCloudProviderProps) {
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider | null>(null);
  const [token, setToken] = useState('');
  const [scalewayProjectId, setScalewayProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isComplete) {
    return (
      <div className="text-center py-6">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-3">
          <span className="text-success text-xl">{'\u2713'}</span>
        </div>
        <p className="sam-type-body text-fg-primary font-medium m-0 mb-1">Cloud provider connected</p>
        <p className="sam-type-caption text-fg-muted m-0">You can manage your credentials in Settings.</p>
        <div className="mt-4">
          <Button variant="primary" size="md" onClick={onComplete}>Continue</Button>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    if (!selectedProvider || !token.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let data: CreateCredentialRequest;
      if (selectedProvider === 'hetzner') {
        data = { provider: 'hetzner', token: token.trim() };
      } else {
        if (!scalewayProjectId.trim()) {
          setError('Scaleway Project ID is required');
          setSaving(false);
          return;
        }
        data = { provider: 'scaleway', secretKey: token.trim(), projectId: scalewayProjectId.trim() };
      }
      await createCredential(data);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  };

  const selectedDef = selectedProvider ? PROVIDERS.find((p) => p.id === selectedProvider) : null;
  const isValid = selectedProvider === 'hetzner'
    ? !!token.trim()
    : !!token.trim() && !!scalewayProjectId.trim();

  return (
    <div>
      <h3 className="sam-type-section-heading text-fg-primary m-0 mb-1">Connect your cloud</h3>
      <p className="sam-type-body text-fg-muted m-0 mb-4">
        SAM provisions VMs on <strong>your</strong> cloud account. You keep full control and pay your provider directly.
      </p>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {/* Provider selection */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => { setSelectedProvider(provider.id); setError(null); }}
            className={`p-3 rounded-md border text-left transition-colors cursor-pointer bg-surface ${
              selectedProvider === provider.id
                ? 'border-accent ring-1 ring-accent'
                : 'border-border-default hover:border-fg-muted'
            }`}
          >
            <span className="block font-medium text-sm text-fg-primary">{provider.name}</span>
            <span className="block text-xs text-fg-muted mt-0.5">{provider.description}</span>
          </button>
        ))}
      </div>

      {/* Token input */}
      {selectedDef && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-fg-primary mb-1">
            {selectedDef.name} API Token
          </label>
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={`Paste your ${selectedDef.name} API token`}
          />

          {selectedProvider === 'scaleway' && (
            <div className="mt-2">
              <label className="block text-sm font-medium text-fg-primary mb-1">
                Scaleway Project ID
              </label>
              <Input
                type="text"
                value={scalewayProjectId}
                onChange={(e) => setScalewayProjectId(e.target.value)}
                placeholder="Your Scaleway project ID"
              />
            </div>
          )}

          <a
            href={selectedDef.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline mt-1 inline-block"
          >
            {selectedDef.helpText}
          </a>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Skip this step
        </button>
        <Button
          variant="primary"
          size="md"
          onClick={handleSave}
          disabled={!isValid || saving}
        >
          {saving ? 'Saving...' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}
