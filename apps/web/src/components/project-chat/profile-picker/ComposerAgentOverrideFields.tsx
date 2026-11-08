import { type AgentEffort, getSupportedEffortsForAgent } from '@simple-agent-manager/shared';
import { useId } from 'react';

import { EFFORT_LABELS } from '../../agent-profiles/profile-form-options';
import { ModelSelect } from '../../ModelSelect';
import {
  activeChatAgentOverrides,
  type ChatAgentDefaults,
  type ChatAgentOverrides,
} from './agent-overrides';
import { modelLabel } from './model';

const SELECT_CLASSES =
  'w-full min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-50';

/**
 * Model and effort for one chat, over the profile/skill values shown as the defaults. Only
 * offers the efforts the chat's agent can run, and hides effort when there is no choice.
 */
export function ComposerAgentOverrideFields({
  defaults,
  overrides,
  onChange,
  disabled,
}: Readonly<{
  defaults: ChatAgentDefaults;
  overrides: ChatAgentOverrides;
  onChange: (next: ChatAgentOverrides) => void;
  disabled: boolean;
}>) {
  const modelId = useId();
  const effortId = useId();
  const { agentType } = defaults;
  if (!agentType) return null;

  // Values chosen for another agent are not shown (or sent); see `activeChatAgentOverrides`.
  const sameAgent = overrides.agentType === agentType;
  const { effort } = activeChatAgentOverrides(overrides, agentType);
  const efforts = getSupportedEffortsForAgent(agentType);
  const defaultModel = defaults.model ? modelLabel({ agentType, model: defaults.model }) : null;
  const update = (patch: Partial<Pick<ChatAgentOverrides, 'model' | 'effort'>>) =>
    onChange({ agentType, model: sameAgent ? overrides.model : '', effort, ...patch });

  return (
    // One row even on a phone: the panel is height-capped and every row counts.
    <div
      className={
        efforts.length > 1
          ? 'grid grid-cols-[minmax(0,1fr)_8rem] gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]'
          : 'grid gap-2'
      }
    >
      <div className="grid min-w-0 gap-0.5">
        <label htmlFor={modelId} className="text-xs text-fg-muted">
          Model
        </label>
        {/* Keyed by agent: its catalog and any half-typed filter belong to that agent. */}
        <ModelSelect
          key={agentType}
          id={modelId}
          agentType={agentType}
          value={sameAgent ? overrides.model : ''}
          onChange={(model) => update({ model })}
          disabled={disabled}
          placeholder={defaultModel ? `Default: ${defaultModel}` : 'Default model'}
        />
      </div>
      {efforts.length > 1 && (
        <div className="grid gap-0.5">
          <label htmlFor={effortId} className="text-xs text-fg-muted">
            Effort
          </label>
          <select
            id={effortId}
            value={effort ?? ''}
            onChange={(event) =>
              update({ effort: (event.target.value || null) as AgentEffort | null })
            }
            disabled={disabled}
            // Muted while inheriting, like the Model field's placeholder.
            className={`${SELECT_CLASSES} ${effort ? 'text-fg-primary' : 'text-fg-muted'}`}
          >
            <option value="">
              {defaults.effort ? `Default: ${EFFORT_LABELS[defaults.effort]}` : 'Default'}
            </option>
            {efforts.map((value) => (
              <option key={value} value={value} className="text-fg-primary">
                {EFFORT_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
