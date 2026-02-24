import { type FC, useState } from 'react';
import type { VMSize } from '@simple-agent-manager/shared';
import { SplitButton } from '../ui/SplitButton';

export interface TaskSubmitFormProps {
  projectId: string;
  hasCloudCredentials: boolean;
  onRunNow: (title: string, options: TaskSubmitOptions) => Promise<void>;
  onSaveToBacklog: (title: string, options: TaskSubmitOptions) => Promise<void>;
}

export interface TaskSubmitOptions {
  description?: string;
  priority?: number;
  agentProfileHint?: string;
  vmSize?: VMSize;
}

export const TaskSubmitForm: FC<TaskSubmitFormProps> = ({
  hasCloudCredentials,
  onRunNow,
  onSaveToBacklog,
}) => {
  const [title, setTitle] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [agentProfileHint, setAgentProfileHint] = useState('');
  const [vmSize, setVmSize] = useState<VMSize | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: TaskSubmitOptions = {
    description: description.trim() || undefined,
    priority: priority || undefined,
    agentProfileHint: agentProfileHint.trim() || undefined,
    vmSize: vmSize || undefined,
  };

  const handleRunNow = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Task description is required');
      return;
    }
    if (!hasCloudCredentials) {
      setError('Cloud credentials required. Go to Settings to connect your Hetzner account.');
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      await onRunNow(trimmed, options);
      setTitle('');
      setDescription('');
      setPriority(0);
      setAgentProfileHint('');
      setVmSize('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run task');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveToBacklog = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Task description is required');
      return;
    }
    try {
      setError(null);
      setSubmitting(true);
      await onSaveToBacklog(trimmed, options);
      setTitle('');
      setDescription('');
      setPriority(0);
      setAgentProfileHint('');
      setVmSize('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      borderTop: '1px solid var(--sam-color-border-default)',
      padding: 'var(--sam-space-3) var(--sam-space-4)',
      backgroundColor: 'var(--sam-color-bg-surface)',
    }}>
      {error && (
        <div style={{
          padding: 'var(--sam-space-2) var(--sam-space-3)',
          marginBottom: 'var(--sam-space-2)',
          borderRadius: 'var(--sam-radius-sm)',
          backgroundColor: 'var(--sam-color-danger-tint)',
          color: 'var(--sam-color-danger)',
          fontSize: 'var(--sam-type-caption-size)',
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <input
            type="text"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !submitting) {
                void handleRunNow();
              }
            }}
            placeholder="Describe the task for the agent..."
            disabled={submitting}
            style={{
              width: '100%',
              padding: 'var(--sam-space-2) var(--sam-space-3)',
              backgroundColor: 'var(--sam-color-bg-page)',
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 'var(--sam-radius-md)',
              color: 'var(--sam-color-fg-primary)',
              fontSize: 'var(--sam-type-body-size)',
              outline: 'none',
            }}
          />
        </div>

        <SplitButton
          primaryLabel="Run Now"
          onPrimaryAction={() => void handleRunNow()}
          options={[
            { label: 'Save to Backlog', onClick: () => void handleSaveToBacklog() },
          ]}
          disabled={submitting}
          loading={submitting}
        />
      </div>

      {/* Advanced options toggle */}
      <div style={{ marginTop: 'var(--sam-space-2)' }}>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--sam-color-fg-muted)',
            fontSize: 'var(--sam-type-caption-size)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced options
        </button>
      </div>

      {showAdvanced && (
        <div style={{
          display: 'grid',
          gap: 'var(--sam-space-2)',
          marginTop: 'var(--sam-space-2)',
          padding: 'var(--sam-space-3)',
          backgroundColor: 'var(--sam-color-bg-page)',
          borderRadius: 'var(--sam-radius-md)',
          border: '1px solid var(--sam-color-border-default)',
        }}>
          <div>
            <label style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', display: 'block', marginBottom: '4px' }}>
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional context for the agent..."
              rows={2}
              style={{
                width: '100%',
                padding: 'var(--sam-space-2)',
                backgroundColor: 'var(--sam-color-bg-surface)',
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-sm)',
                color: 'var(--sam-color-fg-primary)',
                fontSize: 'var(--sam-type-secondary-size)',
                resize: 'vertical',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--sam-space-3)', flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', display: 'block', marginBottom: '4px' }}>
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                style={{
                  padding: 'var(--sam-space-1) var(--sam-space-2)',
                  backgroundColor: 'var(--sam-color-bg-surface)',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-sm)',
                  color: 'var(--sam-color-fg-primary)',
                  fontSize: 'var(--sam-type-secondary-size)',
                }}
              >
                <option value={0}>Normal (0)</option>
                <option value={1}>Low (1)</option>
                <option value={5}>Medium (5)</option>
                <option value={10}>High (10)</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', display: 'block', marginBottom: '4px' }}>
                VM Size
              </label>
              <select
                value={vmSize}
                onChange={(e) => setVmSize(e.target.value as VMSize | '')}
                style={{
                  padding: 'var(--sam-space-1) var(--sam-space-2)',
                  backgroundColor: 'var(--sam-color-bg-surface)',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-sm)',
                  color: 'var(--sam-color-fg-primary)',
                  fontSize: 'var(--sam-type-secondary-size)',
                }}
              >
                <option value="">Default</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', display: 'block', marginBottom: '4px' }}>
                Agent Hint
              </label>
              <input
                type="text"
                value={agentProfileHint}
                onChange={(e) => setAgentProfileHint(e.target.value)}
                placeholder="e.g. claude-code"
                style={{
                  padding: 'var(--sam-space-1) var(--sam-space-2)',
                  backgroundColor: 'var(--sam-color-bg-surface)',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-sm)',
                  color: 'var(--sam-color-fg-primary)',
                  fontSize: 'var(--sam-type-secondary-size)',
                  width: '140px',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
