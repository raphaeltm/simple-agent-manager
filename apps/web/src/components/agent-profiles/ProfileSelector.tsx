import { type FC } from 'react';
import type { AgentProfile } from '@simple-agent-manager/shared';

interface ProfileSelectorProps {
  profiles: AgentProfile[];
  selectedProfileId: string | null;
  onChange: (profileId: string | null) => void;
  disabled?: boolean;
  /** Compact mode for inline use (chat input bar) */
  compact?: boolean;
  className?: string;
}

/**
 * Dropdown selector for agent profiles. Shows profile name + agent type.
 * "No profile" option uses project/platform defaults.
 */
export const ProfileSelector: FC<ProfileSelectorProps> = ({
  profiles,
  selectedProfileId,
  onChange,
  disabled = false,
  compact = false,
  className = '',
}) => {
  const baseClasses = compact
    ? 'px-2 py-1.5 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]'
    : 'w-full py-2.5 px-3 border border-border-default rounded-md bg-surface text-fg-primary min-h-11';

  return (
    <select
      value={selectedProfileId ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      aria-label="Agent profile"
      className={`${baseClasses} ${className}`}
    >
      <option value="">Default (no profile)</option>
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name}
          {profile.model ? ` · ${profile.model}` : ''}
          {profile.isBuiltin ? ' (built-in)' : ''}
        </option>
      ))}
    </select>
  );
};
