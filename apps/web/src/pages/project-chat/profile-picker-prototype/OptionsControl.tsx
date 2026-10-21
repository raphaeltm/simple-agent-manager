/** PROTOTYPE — new-chat profile picker directions. Do not merge to main. */
import type { AgentSkill } from '@simple-agent-manager/shared';
import { SlidersHorizontal } from 'lucide-react';

import {
  hasAnyResourceValue,
  type ResourceRequirementsFormState,
  ResourceRequirementsInput,
  type ResourceValidationErrors,
} from '../../../components/resource-requirements';
import { SkillSelector } from '../../../components/skills/SkillSelector';

export interface OptionsState {
  skills: AgentSkill[];
  selectedSkillId: string | null;
  onSkillChange: (skillId: string | null) => void;
  taskResourceReqs: ResourceRequirementsFormState;
  onTaskResourceReqsChange: (next: ResourceRequirementsFormState) => void;
  taskResourceErrors: ResourceValidationErrors;
  onTaskResourceErrorsClear: () => void;
  disabled: boolean;
}

export function optionsCount(options: OptionsState): number {
  return (
    (options.selectedSkillId ? 1 : 0) + (hasAnyResourceValue(options.taskResourceReqs) ? 1 : 0)
  );
}

export function OptionsButton({
  open,
  count,
  onToggle,
}: Readonly<{ open: boolean; count: number; onToggle: () => void }>) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={count > 0 ? `Options (${count} set)` : 'Options'}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-transparent ${
        open || count > 0
          ? 'border-accent/60 text-accent'
          : 'border-border-default text-fg-muted hover:text-fg-primary'
      }`}
    >
      <SlidersHorizontal size={16} />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
          {count}
        </span>
      )}
    </button>
  );
}

export function OptionsPanel({
  options,
  compact,
}: Readonly<{ options: OptionsState; compact: boolean }>) {
  return (
    <div className="mb-2 grid gap-3 rounded-lg border border-border-default bg-surface p-3">
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
      <div>
        <div className="mb-1 text-xs font-medium text-fg-secondary">Resources for this chat</div>
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
      </div>
    </div>
  );
}
