import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  type AIProxyConfigResponse,
  type BillingMode,
  fetchAIProxyConfig,
  resetAIProxyConfig,
  updateAIProxyBillingMode,
  updateAIProxyConfig,
} from '../lib/api';

const BILLING_MODE_OPTIONS: Array<{ value: BillingMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Use Unified Billing when CF API token is available, otherwise fall back to platform API key.',
  },
  {
    value: 'unified',
    label: 'Unified Billing',
    description: 'Route all requests through Cloudflare credits. Requires CF_API_TOKEN.',
  },
  {
    value: 'platform-key',
    label: 'Platform Key',
    description: 'Use a stored Anthropic API key for authentication.',
  },
];

export function AdminAIProxy() {
  const [config, setConfig] = useState<AIProxyConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');

  const fetchConfig = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchAIProxyConfig();
      setConfig(res);
      setSelectedModel(res.defaultModel);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI proxy config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleSave = async () => {
    if (!selectedModel || selectedModel === config?.defaultModel) return;
    setSaving(true);
    setError(null);
    try {
      await updateAIProxyConfig(selectedModel);
      await fetchConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update config');
    } finally {
      setSaving(false);
    }
  };

  const handleBillingModeChange = async (mode: BillingMode) => {
    setSaving(true);
    setError(null);
    try {
      await updateAIProxyBillingMode(mode);
      await fetchConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update billing mode');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError(null);
    try {
      await resetAIProxyConfig();
      await fetchConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset config');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
        {error || 'Failed to load config'}
      </div>
    );
  }

  const hasChanges = selectedModel !== config.defaultModel;

  return (
    <div className="space-y-6">
      <Body>
        Configure the default AI model and billing mode for the platform inference proxy. This model is used when
        users don&apos;t have their own agent credentials — e.g., during trials or onboarding.
      </Body>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Billing Mode */}
      <Card>
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-2 block text-sm font-medium">Billing Mode</label>
            <div className="space-y-2">
              {BILLING_MODE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--sam-border)] p-3 transition-colors hover:bg-[var(--sam-bg-secondary)]"
                >
                  <input
                    type="radio"
                    name="billingMode"
                    value={option.value}
                    checked={config.billingMode === option.value}
                    onChange={() => handleBillingModeChange(option.value)}
                    disabled={saving}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{option.label}</span>
                    <p className="mt-0.5 text-xs text-[var(--sam-text-secondary)]">
                      {option.description}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--sam-text-secondary)]">
            <span>
              CF API Token:{' '}
              <span className={config.hasCfApiToken
                ? 'font-medium text-green-600 dark:text-green-400'
                : 'font-medium text-yellow-600 dark:text-yellow-400'}>
                {config.hasCfApiToken ? 'configured' : 'not configured'}
              </span>
            </span>
            <span>
              Anthropic key:{' '}
              <span className={config.hasAnthropicCredential
                ? 'font-medium text-green-600 dark:text-green-400'
                : 'font-medium text-yellow-600 dark:text-yellow-400'}>
                {config.hasAnthropicCredential ? 'configured' : 'not configured'}
              </span>
            </span>
          </div>
        </div>
      </Card>

      {/* Default Model */}
      <Card>
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="default-model">
              Default Model
            </label>
            <select
              id="default-model"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] px-3 py-2 text-sm"
            >
              {config.models.map((model) => (
                <option
                  key={model.id}
                  value={model.id}
                  disabled={!model.available}
                >
                  {model.label}
                  {model.provider === 'anthropic' ? ' (Anthropic)' : ' (Workers AI — free)'}
                  {!model.available ? ' — requires credential' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-[var(--sam-text-secondary)]">
              Workers AI models are free and require no API key.
              Anthropic models require either Unified Billing (CF API token) or a Claude Code credential on the{' '}
              <a href="/admin/credentials" className="text-[var(--sam-accent)] underline">
                Credentials
              </a>{' '}
              tab.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--sam-text-secondary)]">
            <span>
              Source:{' '}
              <span className="font-medium text-[var(--sam-text-primary)]">
                {config.source === 'admin' ? 'Admin override' : config.source === 'env' ? 'Environment variable' : 'Platform default'}
              </span>
            </span>
            {config.updatedAt && (
              <span>Last updated: {new Date(config.updatedAt).toLocaleString()}</span>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving || !hasChanges}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
            {config.source === 'admin' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleReset}
                disabled={saving}
              >
                <RotateCcw size={14} />
                Reset to Default
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
