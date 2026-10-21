import type { AgentSkill } from '@simple-agent-manager/shared';
import { SlidersHorizontal } from 'lucide-react';

import {
  hasAnyResourceValue,
  type ResourceRequirementsFormState,
  ResourceRequirementsInput,
  type ResourceValidationErrors,
} from '../../resource-requirements';
import { SkillSelector } from '../../skills/SkillSelector';

export interface ComposerOptionsValue {
  skills: AgentSkill[];
  selectedSkillId: string | null;
  onSkillChange: (skillId: string | null) => void;
  taskResourceReqs: ResourceRequirementsFormState;
  onTaskResourceReqsChange: (next: ResourceRequirementsFormState) => void;
  taskResourceErrors: ResourceValidationErrors;
  onTaskResourceErrorsClear: () => void;
  disabled: boolean;
}

/** How many per-chat options differ from the profile's defaults. */
export function composerOptionsCount(options: ComposerOptionsValue): number {
  return (
    (options.selectedSkillId ? 1 : 0) + (hasAnyResourceValue(options.taskResourceReqs) ? 1 : 0)
  );
}

export function ComposerOptionsButton({
  open,
  count,
  disabled,
  panelId,
  onToggle,
}: Readonly<{
  open: boolean;
  count: number;
  disabled: boolean;
  /** Id of the panel this button shows and hides. */
  panelId: string;
  onToggle: () => void;
}>) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={count > 0 ? `Chat options (${count} set)` : 'Chat options'}
      title="Skill and resources for this chat"
      className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-transparent transition-colors disabled:opacity-50 ${
        open || count > 0
          ? 'border-accent/60 text-accent'
          : 'border-border-default text-fg-muted hover:text-fg-primary'
      }`}
    >
      <SlidersHorizontal size={16} aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white"
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** Per-chat skill and resource overrides, moved out of the always-visible composer. */
export function ComposerOptionsPanel({
  id,
  options,
  compact,
}: Readonly<{ id: string; options: ComposerOptionsValue; compact: boolean }>) {
  return (
    <div id={id} className="mb-2 grid gap-3 rounded-lg border border-border-default bg-surface p-3">
      {options.skills.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-fg-secondary">Skill for this chat</div>
          <SkillSelector
            skills={options.skills}
            selectedSkillId={options.selectedSkillId}
            onChange={options.onSkillChange}
            disabled={options.disabled}
            compact
          />
        </div>
      )}
      <div>
        {/* The full-size input brings its own "Resources" legend; the compact one has none. */}
        {compact && (
          <div className="mb-1 text-xs font-medium text-fg-secondary">Resources for this chat</div>
        )}
        <ResourceRequirementsInput
          value={options.taskResourceReqs}
          onChange={(next) => {
            options.onTaskResourceReqsChange(next);
            options.onTaskResourceErrorsClear();
          }}
          disabled={options.disabled}
          inheritLabel="profile/project default"
          errors={options.taskResourceErrors}
          compact={compact}
        />
        <p className="m-0 mt-1 text-[11px] text-fg-muted">Leave blank to use the profile’s.</p>
      </div>
    </div>
  );
}
