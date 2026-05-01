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
    description: 'Use Unified Billing when CF AIG token is available, otherwise fall back to platform API key.',
  },
  {
    value: 'unified',
    label: 'Unified Billing',
    description: 'Route all requests through Cloudflare credits. Requires CF_AIG_TOKEN.',
  },
  {
    value: 'platform-key',
    label: 'Platform Key',
    description: 'Use a stored provider API key for authentication.',
  },
];

const TIER_LABELS: Record<string, string> = {
  free: 'Free Tier',
  standard: 'Standard',
  premium: 'Premium',
};

const TIER_ORDER: Record<string, number> = {
  free: 0,
  standard: 1,
  premium: 2,
};

const PROVIDER_LABELS: Record<string, string> = {
  'workers-ai': 'Workers AI',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

function formatCost(cost: number): string {
  if (cost === 0) return 'Free';
  if (cost < 0.001) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function tierBadgeClasses(tier: string): string {
  switch (tier) {
    case 'free':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'standard':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    case 'premium':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400';
  }
}

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
      <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
        {error || 'Failed to load config'}
      </div>
    );
  }

  const hasChanges = selectedModel !== config.defaultModel;

  // Group models by tier for display
  const modelsByTier = config.models.reduce<
    Record<string, AIProxyConfigResponse['models']>
  >((acc, model) => {
    const tier = model.tier;
    if (!acc[tier]) acc[tier] = [];
    acc[tier].push(model);
    return acc;
  }, {});

  const sortedTiers = Object.keys(modelsByTier).sort(
    (a, b) => (TIER_ORDER[a] ?? 99) - (TIER_ORDER[b] ?? 99),
  );

  return (
    <div className="space-y-6">
      <Body>
        Configure the default AI model and billing mode for the platform inference proxy. Models are routed
        through Cloudflare AI Gateway. Workers AI models are free; Anthropic and OpenAI models
        require credentials or Unified Billing.
      </Body>

      {error && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Billing Mode */}
      <Card>
        <div className="space-y-4 p-4">
          <fieldset>
            <legend className="mb-2 block text-sm font-medium">Billing Mode</legend>
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
          </fieldset>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--sam-text-secondary)]">
            {config.hasUnifiedBilling && (
              <span className="font-medium text-green-600 dark:text-green-400">
                ● Unified Billing active
              </span>
            )}
            <span>
              Anthropic:{' '}
              <span className={config.hasAnthropicCredential
                ? 'font-medium text-green-600 dark:text-green-400'
                : 'font-medium text-yellow-600 dark:text-yellow-400'}>
                {config.hasAnthropicCredential ? '● configured' : '○ not configured'}
              </span>
            </span>
            <span>
              OpenAI:{' '}
              <span className={config.hasOpenAICredential
                ? 'font-medium text-green-600 dark:text-green-400'
                : 'font-medium text-yellow-600 dark:text-yellow-400'}>
                {config.hasOpenAICredential ? '● configured' : '○ not configured'}
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
              {sortedTiers.map((tier) => (
                <optgroup key={tier} label={TIER_LABELS[tier] ?? tier}>
                  {modelsByTier[tier]?.map((model) => (
                    <option
                      key={model.id}
                      value={model.id}
                      disabled={!model.available}
                    >
                      {model.label} ({PROVIDER_LABELS[model.provider] ?? model.provider})
                      {model.costPer1kInputTokens > 0
                        ? ` — ${formatCost(model.costPer1kInputTokens)}/1K in`
                        : ''}
                      {!model.available ? ' — requires credentials' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-[var(--sam-text-secondary)]">
              Workers AI models are free. Anthropic and OpenAI models require credentials on the{' '}
              <a href="/admin/credentials" className="text-[var(--sam-accent)] underline">
                Credentials
              </a>{' '}
              tab or Unified Billing via <code className="text-xs">CF_AIG_TOKEN</code>.
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

      {/* Model catalog with tier badges and cost info */}
      <Card>
        <div className="p-4">
          <h3 className="mb-3 text-sm font-medium">Available Models</h3>
          <div className="space-y-3">
            {sortedTiers.map((tier) => (
              <div key={tier}>
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tierBadgeClasses(tier)}`}>
                    {TIER_LABELS[tier] ?? tier}
                  </span>
                </div>
                <div className="space-y-1">
                  {modelsByTier[tier]?.map((model) => (
                    <div
                      key={model.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--sam-border)] px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{model.label}</span>
                      <span className="text-xs text-[var(--sam-text-secondary)]">
                        {PROVIDER_LABELS[model.provider] ?? model.provider}
                      </span>
                      {model.costPer1kInputTokens > 0 ? (
                        <span className="text-xs text-[var(--sam-text-secondary)]">
                          {formatCost(model.costPer1kInputTokens)}/1K in &middot;{' '}
                          {formatCost(model.costPer1kOutputTokens)}/1K out
                        </span>
                      ) : (
                        <span className="text-xs text-green-600 dark:text-green-400">Free</span>
                      )}
                      {!model.available && (
                        <span className="text-xs text-yellow-600 dark:text-yellow-400">
                          Requires credentials
                        </span>
                      )}
                      {model.id === config.defaultModel && (
                        <span className="rounded bg-[var(--sam-accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--sam-accent)]">
                          Default
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
