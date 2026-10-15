import type {
  CapacityExhaustionPolicy,
  CapacityPool,
  CapacityPoolStrategy,
  DefaultCapacityPoolUpdateRequest,
} from '@simple-agent-manager/shared';
import {
  CAPACITY_EXHAUSTION_POLICIES,
  CAPACITY_POOL_STRATEGIES,
  DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY,
  DEFAULT_CAPACITY_POOL_MAX_NODES,
} from '@simple-agent-manager/shared';
import { Button, Input, Select } from '@simple-agent-manager/ui';
import { useId, useState } from 'react';

import {
  type ChoiceCopy,
  DEPLOYMENT_STRATEGY_HELP,
  EXHAUSTION_POLICY_COPY,
  EXHAUSTION_POLICY_TITLE,
  MACHINE_LIMIT_HELP,
  POOL_SCOPE_COPY,
  SPREAD_MACHINE_LIMIT_NOTE,
  WORKSPACE_STRATEGY_COPY,
} from '../../lib/compute-pool-copy';
import {
  buildMachineChanges,
  type MachineCell,
  type MachineDraft,
  type MachineGroup,
  toggleCell,
} from '../../lib/compute-pool-machines';
import { MachinePicker } from './MachinePicker';

interface PolicyDraft {
  strategy: CapacityPoolStrategy;
  deploymentStrategy: CapacityPoolStrategy;
  exhaustionPolicy: CapacityExhaustionPolicy;
  maxNodes: number;
}

function initialPolicy(pool: CapacityPool): PolicyDraft {
  return {
    strategy: pool.strategy,
    deploymentStrategy: pool.deploymentStrategy ?? DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY,
    exhaustionPolicy: pool.exhaustionPolicy,
    maxNodes: pool.maxNodes ?? DEFAULT_CAPACITY_POOL_MAX_NODES,
  };
}

function policyChanges(pool: CapacityPool, draft: PolicyDraft) {
  const initial = initialPolicy(pool);
  const policy: NonNullable<DefaultCapacityPoolUpdateRequest['policy']> = {};
  if (draft.strategy !== initial.strategy) policy.strategy = draft.strategy;
  if (draft.deploymentStrategy !== initial.deploymentStrategy) {
    policy.deploymentStrategy = draft.deploymentStrategy;
  }
  if (draft.exhaustionPolicy !== initial.exhaustionPolicy) {
    policy.exhaustionPolicy = draft.exhaustionPolicy;
  }
  if (draft.maxNodes !== initial.maxNodes) policy.maxNodes = draft.maxNodes;
  return policy;
}

function ChoiceField<T extends string>({
  label,
  value,
  options,
  copy,
  help,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  copy: Record<T, ChoiceCopy>;
  help?: string;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <Select
        id={id}
        value={value}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {copy[option].label}
          </option>
        ))}
      </Select>
      <p id={`${id}-help`} className="m-0 text-xs text-fg-muted">
        {help ?? copy[value].description}
      </p>
    </div>
  );
}

interface ComputePoolEditorProps {
  pool: CapacityPool;
  groups: MachineGroup[];
  saving: boolean;
  onCancel: () => void;
  onSave: (request: DefaultCapacityPoolUpdateRequest | null) => void;
}

export function ComputePoolEditor({
  pool,
  groups,
  saving,
  onCancel,
  onSave,
}: ComputePoolEditorProps) {
  const limitId = useId();
  const [policy, setPolicy] = useState<PolicyDraft>(() => initialPolicy(pool));
  const [draft, setDraft] = useState<MachineDraft>(() => new Map());
  const changedPolicy = policyChanges(pool, policy);
  const changeCount = Object.keys(changedPolicy).length + draft.size;
  const update = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) =>
    setPolicy((current) => ({ ...current, [key]: value }));

  const save = () => {
    const machines = buildMachineChanges(groups, draft);
    const request: DefaultCapacityPoolUpdateRequest = {};
    if (Object.keys(changedPolicy).length > 0) request.policy = changedPolicy;
    if (machines.candidates.length > 0) request.candidates = machines.candidates;
    if (machines.catalogAdditions.length > 0) request.catalogAdditions = machines.catalogAdditions;
    onSave(request.policy || request.candidates || request.catalogAdditions ? request : null);
  };

  return (
    <div className="grid min-w-0 gap-5">
      <section className="grid min-w-0 gap-3" aria-label="How SAM uses machines">
        <h3 className="m-0 text-sm font-semibold text-fg-primary">How SAM uses machines</h3>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <ChoiceField
            label="Placing agents"
            value={policy.strategy}
            options={CAPACITY_POOL_STRATEGIES}
            copy={WORKSPACE_STRATEGY_COPY}
            onChange={(value) => update('strategy', value)}
          />
          <ChoiceField
            label={EXHAUSTION_POLICY_TITLE}
            value={policy.exhaustionPolicy}
            options={CAPACITY_EXHAUSTION_POLICIES}
            copy={EXHAUSTION_POLICY_COPY}
            onChange={(value) => update('exhaustionPolicy', value)}
          />
          <div className="grid min-w-0 gap-1">
            <label htmlFor={limitId} className="text-xs font-medium text-fg-muted">
              Machine limit{POOL_SCOPE_COPY[pool.scope].limitPerPerson ? ' per person' : ''}
            </label>
            <Input
              id={limitId}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-describedby={`${limitId}-help`}
              value={policy.maxNodes}
              onChange={(event) => {
                const value = Number.parseInt(event.currentTarget.value, 10);
                if (Number.isSafeInteger(value) && value > 0) update('maxNodes', value);
              }}
            />
            <p id={`${limitId}-help`} className="m-0 text-xs text-fg-muted">
              {MACHINE_LIMIT_HELP}
              {policy.strategy === 'spread' ? ` ${SPREAD_MACHINE_LIMIT_NOTE}` : ''}
            </p>
          </div>
          <ChoiceField
            label="App deployments"
            value={policy.deploymentStrategy}
            options={CAPACITY_POOL_STRATEGIES}
            copy={WORKSPACE_STRATEGY_COPY}
            help={DEPLOYMENT_STRATEGY_HELP}
            onChange={(value) => update('deploymentStrategy', value)}
          />
        </div>
      </section>

      <MachinePicker
        groups={groups}
        draft={draft}
        onToggle={(cell: MachineCell) => setDraft((current) => toggleCell(current, cell))}
      />

      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t border-border-default bg-surface px-4 py-3">
        <span className="text-xs text-fg-muted" aria-live="polite">
          {changeCount === 0
            ? 'No changes yet'
            : `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}`}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" loading={saving} disabled={saving || changeCount === 0} onClick={save}>
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
