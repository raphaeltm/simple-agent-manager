import type { AgentSkill } from '@simple-agent-manager/shared';
import { Zap } from 'lucide-react';
import { type FC } from 'react';

interface SkillSelectorProps {
  skills: AgentSkill[];
  selectedSkillId: string | null;
  onChange: (skillId: string | null) => void;
  disabled?: boolean;
  compact?: boolean;
  id?: string;
}

function formatResourceSummary(skill: AgentSkill | null) {
  if (!skill?.resourceRequirementsJson) return null;
  try {
    const req = JSON.parse(skill.resourceRequirementsJson) as Record<string, unknown>;
    return [
      typeof req.minVcpu === 'number' ? `${req.minVcpu} vCPU` : null,
      typeof req.minMemoryGb === 'number' ? `${req.minMemoryGb} GB RAM` : null,
      typeof req.minDiskGb === 'number' ? `${req.minDiskGb} GB disk` : null,
    ].filter(Boolean).join(' · ') || null;
  } catch {
    return null;
  }
}

export const SkillSelector: FC<SkillSelectorProps> = ({
  skills,
  selectedSkillId,
  onChange,
  disabled = false,
  compact = false,
  id,
}) => {
  const selected = selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) ?? null : null;
  const summary = formatResourceSummary(selected);
  const classes = compact
    ? 'px-2 py-1.5 border border-border-default rounded-md bg-page text-fg-primary text-xs cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)]'
    : 'w-full py-2.5 px-3 border border-border-default rounded-md bg-surface text-fg-primary min-h-11';

  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-1.5">
        <Zap size={compact ? 14 : 16} className="text-fg-muted" />
        <select
          id={id}
          value={selectedSkillId ?? ''}
          onChange={(event) => onChange(event.target.value || null)}
          disabled={disabled}
          aria-label="Skill"
          className={classes}
        >
          <option value="">No skill</option>
          {skills.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name}
            </option>
          ))}
        </select>
      </div>
      {selected && (
        <div className="text-xs text-fg-muted line-clamp-2">
          {selected.description || 'Skill selected'}
          {summary ? ` · ${summary}` : ''}
        </div>
      )}
    </div>
  );
};

export { formatResourceSummary };
