import { type AgentProfile, DEFAULT_AGENT_EFFORT } from '@simple-agent-manager/shared';

import { EFFORT_LABELS, FOCUS_RING } from './trigger-form-support';

interface TriggerProfileSelectProps {
  profiles: AgentProfile[];
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}

export function TriggerProfileSelect({
  profiles,
  value,
  required = false,
  onChange,
}: TriggerProfileSelectProps) {
  return (
    <div>
      <label htmlFor="agent-profile" className="block text-sm text-fg-primary mb-1">
        Agent Profile {required && <span className="text-danger">*</span>}
      </label>
      <select
        id="agent-profile"
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
      >
        <option value="">{required ? 'Select a profile' : 'Project default'}</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
            {profile.model ? ` (${profile.model})` : ''}
            {profile.effort !== DEFAULT_AGENT_EFFORT ? ` · ${EFFORT_LABELS[profile.effort]}` : ''}
          </option>
        ))}
      </select>
      {required && (
        <p className="text-xs text-fg-muted mt-1 mb-0">
          Webhook deliveries always run with this explicit profile.
        </p>
      )}
    </div>
  );
}
