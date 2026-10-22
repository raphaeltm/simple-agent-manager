import { resolveAgentModelAccess } from '@simple-agent-manager/shared';
import { Button, Select } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import {
  agentModelCatalogQueryOptions,
  projectAgentModelSettingsQueryOptions,
} from '../../lib/query-options';
import { indexCatalog, summarizeModelsByCategory } from './model-picker-utils';
import { ModelPicker } from './ModelPicker';

export interface AgentModelAccessFieldProps {
  projectId: string;
  /** Copy only: renders as "AI models this {ownerLabel} can call". Also selects the inherit-option wording and "Same as profile" vs "Same as project" context. */
  ownerLabel: 'profile' | 'skill';
  /** The stored override on this profile/skill. null = inherit the layer below. */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
  /**
   * Skill context only: the skill's chosen default profile (or `null` when
   * none is chosen), so "Same as profile" seeds Custom from the profile's
   * own override before falling back to the project. Omit entirely for
   * profile context, where the only layer below is the project.
   */
  fallbackProfile?: { name: string; agentModels: string[] | null } | null;
}

/**
 * The project/profile/skill "inherit vs custom" override field for agent
 * model calls — one implementation shared by `ProfileFormDialog` and
 * `SkillFormDialog` (`.claude/rules/24`). Mirrors the existing "GitHub CLI
 * access" inherit/custom `<select>` pattern in `ProfileFormDialog` rather
 * than inventing a new toggle shape.
 */
export function AgentModelAccessField({
  projectId,
  ownerLabel,
  value,
  onChange,
  disabled,
  fallbackProfile,
}: AgentModelAccessFieldProps) {
  const queryScope = useQueryScope();
  const catalogQuery = useQuery(agentModelCatalogQueryOptions(queryScope));
  const projectSettingsQuery = useQuery({
    ...projectAgentModelSettingsQueryOptions(queryScope, projectId),
    enabled: Boolean(projectId && queryScope),
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  const catalogById = indexCatalog(catalogQuery.data?.models ?? []);
  const defaultModelIds = catalogQuery.data?.defaultModelIds ?? [];
  const resolving = catalogQuery.isLoading || projectSettingsQuery.isLoading;
  const isSkillContext = fallbackProfile !== undefined;

  // What this profile/skill would actually get right now if left on
  // "inherit" — used to SEED the picker when switching into Custom, so the
  // starting point is the effective current state, not an empty selection.
  const inherited = resolveAgentModelAccess(
    {
      profile: fallbackProfile ? fallbackProfile.agentModels : undefined,
      project: projectSettingsQuery.data?.models,
    },
    defaultModelIds
  );

  // The project's OWN layer alone (ignoring any profile override) — the
  // skill helper text's "Project: <summary>" is a stable reference point
  // regardless of which profile ends up chosen when a task actually runs,
  // since `defaultProfileId` is only a default, not a hard binding.
  const projectOnly = resolveAgentModelAccess(
    { project: projectSettingsQuery.data?.models },
    defaultModelIds
  );

  // The Select's displayed mode leads `value` while the picker is open: opening
  // it must not itself commit a custom override (`onChange` fires only on Save),
  // so a cancel leaves `value` — and therefore the dropdown — exactly as it was.
  const mode = pickerOpen ? 'custom' : value === null ? 'inherit' : 'custom';

  function handleModeChange(nextMode: 'inherit' | 'custom') {
    if (nextMode === 'inherit') {
      onChange(null);
      return;
    }
    setPickerOpen(true);
  }

  return (
    <div className="grid min-w-0 gap-2">
      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">AI models this {ownerLabel} can call</span>
        <Select
          value={mode}
          onChange={(event) => handleModeChange(event.target.value as 'inherit' | 'custom')}
          disabled={disabled}
        >
          <option value="inherit">{isSkillContext ? 'Same as profile' : 'Same as project'}</option>
          <option value="custom">Choose models</option>
        </Select>
      </label>

      {mode === 'inherit' ? (
        <p className="m-0 min-w-0 break-words text-xs text-fg-muted">
          {resolving
            ? 'Loading…'
            : isSkillContext
              ? `Uses the profile's choice, or the project's if the profile has none. Project's choice: ${summarizeModelsByCategory(projectOnly.modelIds, catalogById)}`
              : `The project's choice: ${summarizeModelsByCategory(inherited.modelIds, catalogById)}`}
        </p>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border-default bg-inset px-3 py-2.5">
          <span className="min-w-0 break-words text-sm text-fg-primary">
            {(value?.length ?? 0) === 0
              ? `No models. Agents using this ${ownerLabel} can't call any.`
              : summarizeModelsByCategory(value ?? [], catalogById)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => setPickerOpen(true)}
          >
            Edit
          </Button>
        </div>
      )}

      <ModelPicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        initialSelection={value ?? inherited.modelIds}
        onSave={(ids) => onChange(ids)}
      />
    </div>
  );
}
