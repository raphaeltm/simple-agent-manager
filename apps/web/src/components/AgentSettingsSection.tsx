import { useState, useEffect, useCallback } from 'react';
import { listAgents, getAgentSettings, saveAgentSettings, deleteAgentSettings } from '../lib/api';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import type { AgentInfo, AgentSettingsResponse, AgentPermissionMode, AgentType } from '@simple-agent-manager/shared';
import { AGENT_PERMISSION_MODE_LABELS, VALID_PERMISSION_MODES } from '@simple-agent-manager/shared';

/**
 * Per-agent settings card for model selection and permission mode.
 */
function AgentSettingsCard({
  agent,
  settings,
  onSave,
  onReset,
}: {
  agent: AgentInfo;
  settings: AgentSettingsResponse | null;
  onSave: (agentType: AgentType, model: string | null, permissionMode: AgentPermissionMode | null) => Promise<void>;
  onReset: (agentType: AgentType) => Promise<void>;
}) {
  const [model, setModel] = useState(settings?.model ?? '');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    settings?.permissionMode ?? 'default'
  );
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Sync state when settings prop changes
  useEffect(() => {
    setModel(settings?.model ?? '');
    setPermissionMode(settings?.permissionMode ?? 'default');
  }, [settings]);

  const handleSave = async () => {
    try {
      setError(null);
      setSuccess(false);
      setSaving(true);
      await onSave(
        agent.id,
        model.trim() || null,
        permissionMode
      );
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      setError(null);
      setSuccess(false);
      setResetting(true);
      await onReset(agent.id);
      setModel('');
      setPermissionMode('default');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset settings');
    } finally {
      setResetting(false);
    }
  };

  const modelPlaceholder = (() => {
    switch (agent.id) {
      case 'claude-code':
        return 'e.g. claude-opus-4-6, claude-sonnet-4-5-20250929';
      case 'openai-codex':
        return 'e.g. gpt-5-codex, o3';
      case 'google-gemini':
        return 'e.g. gemini-2.5-pro';
      default:
        return 'Model identifier';
    }
  })();

  const hasChanges =
    (model.trim() || null) !== (settings?.model ?? null) ||
    permissionMode !== (settings?.permissionMode ?? 'default');

  return (
    <div className="p-4 rounded-md border border-border-default bg-inset" data-testid={`agent-settings-${agent.id}`}>
      <div className="mb-2 font-semibold text-base text-fg-primary">
        {agent.name}
      </div>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {success && (
        <div className="mb-3">
          <Alert variant="success">Settings saved</Alert>
        </div>
      )}

      {/* Model selection */}
      <div className="mb-4">
        <div className="text-sm font-medium text-fg-primary mb-1">Model</div>
        <div className="text-xs text-fg-muted mb-2">
          Leave empty to use the default model. Model availability depends on your API key or subscription.
        </div>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={modelPlaceholder}
          className="w-full py-2 px-3 rounded-md border border-border-default bg-surface text-fg-primary text-sm outline-none box-border"
          data-testid={`model-input-${agent.id}`}
        />
      </div>

      {/* Permission mode */}
      <div className="mb-4">
        <div className="text-sm font-medium text-fg-primary mb-1">Permission Mode</div>
        <div className="text-xs text-fg-muted mb-2">
          Controls how the agent handles file edits and tool execution.
        </div>
        <div className="flex flex-col gap-2">
          {VALID_PERMISSION_MODES.map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm text-fg-primary cursor-pointer">
              <input
                type="radio"
                name={`permission-mode-${agent.id}`}
                value={mode}
                checked={permissionMode === mode}
                onChange={() => setPermissionMode(mode as AgentPermissionMode)}
                data-testid={`permission-mode-${agent.id}-${mode}`}
              />
              {AGENT_PERMISSION_MODE_LABELS[mode] || mode}
            </label>
          ))}
        </div>
        {permissionMode === 'bypassPermissions' && (
          <div className="text-xs text-danger-fg py-2 px-3 rounded-md bg-danger-tint mt-1">
            Warning: This disables all safety prompts. The agent will execute commands and edit files without confirmation.
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 flex-wrap">
        <button
          onClick={handleSave}
          disabled={saving || resetting || !hasChanges}
          className={`py-2 px-4 rounded-md border-none bg-accent text-fg-on-accent text-sm font-medium cursor-pointer min-h-[40px] ${
            saving || resetting || !hasChanges ? 'opacity-50' : 'opacity-100'
          }`}
          data-testid={`save-settings-${agent.id}`}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving || resetting}
          className={`py-2 px-4 rounded-md border border-border-default bg-transparent text-fg-muted text-sm font-medium cursor-pointer min-h-[40px] ${
            saving || resetting ? 'opacity-60' : 'opacity-100'
          }`}
          data-testid={`reset-settings-${agent.id}`}
        >
          {resetting ? 'Resetting...' : 'Reset to Defaults'}
        </button>
      </div>
    </div>
  );
}

/**
 * Section that displays agent settings cards for all configured agents.
 */
export function AgentSettingsSection() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [settingsMap, setSettingsMap] = useState<Record<string, AgentSettingsResponse>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const agentResult = await listAgents();
      setAgents(agentResult.agents);

      // Fetch settings for each agent type
      const settingsEntries = await Promise.all(
        agentResult.agents.map(async (agent) => {
          try {
            const s = await getAgentSettings(agent.id);
            return [agent.id, s] as const;
          } catch {
            return [agent.id, null] as const;
          }
        })
      );

      const map: Record<string, AgentSettingsResponse> = {};
      for (const [agentType, s] of settingsEntries) {
        if (s) {
          map[agentType] = s;
        }
      }
      setSettingsMap(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async (
    agentType: AgentType,
    model: string | null,
    permissionMode: AgentPermissionMode | null
  ) => {
    const result = await saveAgentSettings(agentType, { model, permissionMode });
    setSettingsMap((prev) => ({ ...prev, [agentType]: result }));
  };

  const handleReset = async (agentType: AgentType) => {
    await deleteAgentSettings(agentType);
    setSettingsMap((prev) => {
      const next = { ...prev };
      delete next[agentType];
      return next;
    });
  };

  if (loading && agents.length === 0) {
    return (
      <div className="flex justify-center p-4">
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return <Alert variant="error">{error}</Alert>;
  }

  return (
    <div className="flex flex-col gap-4">
      {agents.map((agent) => (
        <AgentSettingsCard
          key={agent.id}
          agent={agent}
          settings={settingsMap[agent.id] ?? null}
          onSave={handleSave}
          onReset={handleReset}
        />
      ))}
    </div>
  );
}
