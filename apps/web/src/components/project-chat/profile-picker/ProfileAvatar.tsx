import type { AgentProfile } from '@simple-agent-manager/shared';

import { profileGlyph } from './model';

/** Agent family tint: Claude, Codex and OpenCode read apart at a glance. */
const TONES: Record<string, string> = {
  'claude-code': 'bg-warning-tint text-warning-fg',
  'openai-codex': 'bg-info-tint text-info-fg',
  opencode: 'bg-accent-tint text-accent',
};

const SIZES = {
  sm: 'h-6 w-6 rounded-md text-[11px]',
  md: 'h-8 w-8 rounded-md text-xs',
} as const;

/**
 * A profile's model initial on its agent's tint, e.g. "O" for Opus on Claude amber.
 * Decorative and aria-hidden: it always sits beside the visible profile name, inside a
 * control that has its own accessible name. Not the shared `Avatar`, which is a labelled
 * identity badge (a name's initials, human/agent/neutral tones) rather than a model glyph
 * tinted per agent family.
 */
export function ProfileAvatar({
  profile,
  size = 'md',
}: Readonly<{ profile: Pick<AgentProfile, 'agentType' | 'model'>; size?: keyof typeof SIZES }>) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center font-semibold ${SIZES[size]} ${
        TONES[profile.agentType] ?? 'bg-inset text-fg-muted'
      }`}
    >
      {profileGlyph(profile)}
    </span>
  );
}
