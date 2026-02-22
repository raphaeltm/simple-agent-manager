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

  const cardStyle: React.CSSProperties = {
    padding: 'var(--sam-space-4)',
    borderRadius: 'var(--sam-radius-md)',
    border: '1px solid var(--sam-color-border-default)',
    backgroundColor: 'var(--sam-color-bg-inset)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--sam-type-secondary-size)',
    fontWeight: 500,
    color: 'var(--sam-color-fg-primary)',
    marginBottom: 'var(--sam-space-1)',
  };

  const descStyle: React.CSSProperties = {
    fontSize: 'var(--sam-type-caption-size)',
    color: 'var(--sam-color-fg-muted)',
    marginBottom: 'var(--sam-space-2)',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: 'var(--sam-space-2) var(--sam-space-3)',
    borderRadius: 'var(--sam-radius-md)',
    border: '1px solid var(--sam-color-border-default)',
    backgroundColor: 'var(--sam-color-bg-surface)',
    color: 'var(--sam-color-fg-primary)',
    fontSize: 'var(--sam-type-secondary-size)',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const radioGroupStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--sam-space-2)',
  };

  const radioLabelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-2)',
    fontSize: 'var(--sam-type-secondary-size)',
    color: 'var(--sam-color-fg-primary)',
    cursor: 'pointer',
  };

  const buttonStyle = (variant: 'primary' | 'secondary'): React.CSSProperties => ({
    padding: 'var(--sam-space-2) var(--sam-space-4)',
    borderRadius: 'var(--sam-radius-md)',
    border: variant === 'primary' ? 'none' : '1px solid var(--sam-color-border-default)',
    backgroundColor: variant === 'primary' ? 'var(--sam-color-accent-primary)' : 'transparent',
    color: variant === 'primary' ? 'var(--sam-color-fg-on-accent)' : 'var(--sam-color-fg-muted)',
    fontSize: 'var(--sam-type-secondary-size)',
    fontWeight: 500,
    cursor: 'pointer',
    minHeight: 40,
    opacity: saving || resetting ? 0.6 : 1,
  });

  const warningStyle: React.CSSProperties = {
    fontSize: 'var(--sam-type-caption-size)',
    color: 'var(--sam-color-status-error)',
    padding: 'var(--sam-space-2) var(--sam-space-3)',
    borderRadius: 'var(--sam-radius-md)',
    backgroundColor: 'var(--sam-color-danger-tint)',
    marginTop: 'var(--sam-space-1)',
  };

  return (
    <div style={cardStyle} data-testid={`agent-settings-${agent.id}`}>
      <div style={{ marginBottom: 'var(--sam-space-2)', fontWeight: 600, fontSize: 'var(--sam-type-body-size)', color: 'var(--sam-color-fg-primary)' }}>
        {agent.name}
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {success && (
        <div style={{ marginBottom: 'var(--sam-space-3)' }}>
          <Alert variant="success">Settings saved</Alert>
        </div>
      )}

      {/* Model selection */}
      <div style={{ marginBottom: 'var(--sam-space-4)' }}>
        <div style={labelStyle}>Model</div>
        <div style={descStyle}>
          Leave empty to use the default model. Model availability depends on your API key or subscription.
        </div>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={modelPlaceholder}
          style={inputStyle}
          data-testid={`model-input-${agent.id}`}
        />
      </div>

      {/* Permission mode */}
      <div style={{ marginBottom: 'var(--sam-space-4)' }}>
        <div style={labelStyle}>Permission Mode</div>
        <div style={descStyle}>
          Controls how the agent handles file edits and tool execution.
        </div>
        <div style={radioGroupStyle}>
          {VALID_PERMISSION_MODES.map((mode) => (
            <label key={mode} style={radioLabelStyle}>
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
          <div style={warningStyle}>
            Warning: This disables all safety prompts. The agent will execute commands and edit files without confirmation.
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 'var(--sam-space-3)', flexWrap: 'wrap' }}>
        <button
          onClick={handleSave}
          disabled={saving || resetting || !hasChanges}
          style={{
            ...buttonStyle('primary'),
            opacity: saving || resetting || !hasChanges ? 0.5 : 1,
          }}
          data-testid={`save-settings-${agent.id}`}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving || resetting}
          style={buttonStyle('secondary')}
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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-4)' }}>
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return <Alert variant="error">{error}</Alert>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
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
