import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  type AIProxyConfigResponse,
  fetchAIProxyConfig,
  resetAIProxyConfig,
  updateAIProxyConfig,
} from '../lib/api';

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
        Configure the default AI model for the platform inference proxy. This model is used when
        users don&apos;t have their own agent credentials — e.g., during trials or onboarding.
      </Body>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

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
                  {!model.available ? ' — requires API key' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-[var(--sam-text-secondary)]">
              Workers AI models are free and require no API key.
              Anthropic models require a Claude Code credential on the{' '}
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
            <span>
              Anthropic key:{' '}
              <span className={config.hasAnthropicCredential
                ? 'font-medium text-green-600 dark:text-green-400'
                : 'font-medium text-yellow-600 dark:text-yellow-400'}>
                {config.hasAnthropicCredential ? 'configured' : 'not configured'}
              </span>
            </span>
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
