import type { CapacityPool, DefaultCapacityPoolUpdateRequest } from '@simple-agent-manager/shared';
import { Button, Chip } from '@simple-agent-manager/ui';
import { useMemo, useState } from 'react';

import { POOL_EDITOR_COPY } from '../../lib/compute-pool-copy';
import { buildMachineChanges, type MachineGroup } from '../../lib/compute-pool-machines';
import {
  buildMachineRegionRows,
  isRowAllowed,
  type MachineRegionRow,
  type RegionDraft,
  setRows,
  zoneDraftForRows,
} from '../../lib/compute-pool-region-rows';
import {
  type OrderableSource,
  sameSourceOrder,
  toSourceOrderRequest,
} from '../../lib/compute-pool-source-order';
import { MachineCatalogPane } from './MachineCatalogPane';
import { PoolAccountsPane } from './PoolAccountsPane';
import {
  initialPolicy,
  policyChanges,
  type PolicyDraft,
  PoolSettingsSection,
} from './PoolSettingsSection';

interface ComputePoolEditorProps {
  pool: CapacityPool;
  /** Machine groups of the accounts that are connected (disconnected ones are left out). */
  groups: MachineGroup[];
  sources: OrderableSource[];
  /** The order the editor opened with (see `initialSourceOrder`). */
  initialOrder: string[] | null;
  saving: boolean;
  /** A pool this scope uses but does not own: shown, not editable. */
  readOnly?: boolean;
  onDiscard: () => void;
  onSave: (request: DefaultCapacityPoolUpdateRequest) => void;
}

function sameIds(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id));
}

/**
 * The compute pool editor: the accounts in the pool with the machines picked from each, and the
 * list of every machine × region the connected accounts offer. Edits are a draft until saved,
 * and one save is one atomic PATCH.
 */
export function ComputePoolEditor({
  pool,
  groups,
  sources,
  initialOrder,
  saving,
  readOnly = false,
  onDiscard,
  onSave,
}: ComputePoolEditorProps) {
  const rows = useMemo(() => buildMachineRegionRows(groups), [groups]);
  const [draft, setDraft] = useState<RegionDraft>(() => new Map());
  const [policy, setPolicy] = useState<PolicyDraft>(() => initialPolicy(pool));
  // Pinned when the editor opens: a background refetch must not turn an untouched value into a
  // change that would write it back over a newer one.
  const [baselineExcluded] = useState<string[]>(() => pool.excludedSourceIds ?? []);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set(baselineExcluded));
  const [baselineOrder] = useState<string[] | null>(initialOrder);
  const [order, setOrder] = useState<string[] | null>(initialOrder);

  const accountRank = useMemo(
    () => new Map((order ?? sources.map((source) => source.id)).map((id, i) => [id, i])),
    [order, sources]
  );
  const usableCount = rows.filter(
    (row) => isRowAllowed(row, draft) && !excluded.has(row.sourceId)
  ).length;
  const changedPolicy = policyChanges(pool, policy);
  const orderChanged = !sameSourceOrder(order, baselineOrder);
  const excludedChanged = !sameIds(excluded, baselineExcluded);
  const changeCount =
    Object.keys(changedPolicy).length +
    draft.size +
    (orderChanged ? 1 : 0) +
    (excludedChanged ? 1 : 0);

  const setRowsInPool = (target: MachineRegionRow[], inPool: boolean) => {
    setDraft((current) => setRows(current, target, inPool));
    // Adding a machine from an account that is off switches the account on (the server does the
    // same), so the pick is used.
    if (inPool) {
      setExcluded((current) => {
        const next = new Set(current);
        for (const row of target) next.delete(row.sourceId);
        return next;
      });
    }
  };

  const save = () => {
    const machines = buildMachineChanges(groups, zoneDraftForRows(rows, draft));
    const request: DefaultCapacityPoolUpdateRequest = {};
    if (Object.keys(changedPolicy).length > 0) request.policy = changedPolicy;
    if (machines.candidates.length > 0) request.candidates = machines.candidates;
    if (machines.catalogAdditions.length > 0) request.catalogAdditions = machines.catalogAdditions;
    if (orderChanged) request.sourceOrder = toSourceOrderRequest(order);
    if (excludedChanged) request.excludedSourceIds = [...excluded];
    if (Object.keys(request).length === 0) onDiscard();
    else onSave(request);
  };

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {usableCount > 0 ? (
          <Chip tone="success" dot>
            Ready · {usableCount} in pool
          </Chip>
        ) : (
          <Chip tone="warning" dot>
            Empty · Instant sessions only
          </Chip>
        )}
        {!readOnly && (
          <span className="text-xs text-fg-muted">{POOL_EDITOR_COPY.nothingAddedOnItsOwn}</span>
        )}
      </div>

      <PoolAccountsPane
        accounts={sources}
        rows={rows}
        draft={draft}
        excluded={excluded}
        order={order}
        usableCount={usableCount}
        readOnly={readOnly}
        onAccountChange={(sourceId, on) =>
          setExcluded((current) => {
            const next = new Set(current);
            if (on) next.delete(sourceId);
            else next.add(sourceId);
            return next;
          })
        }
        onOrderChange={setOrder}
        onRemoveRows={(target) => setRowsInPool(target, false)}
      />

      <MachineCatalogPane
        rows={rows}
        accounts={sources}
        accountRank={accountRank}
        draft={draft}
        excluded={excluded}
        readOnly={readOnly}
        onSetRows={setRowsInPool}
      />

      <PoolSettingsSection pool={pool} policy={policy} readOnly={readOnly} onChange={setPolicy} />

      {!readOnly && changeCount > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t border-border-default bg-surface px-4 py-3">
          <span className="text-xs text-fg-muted" aria-live="polite">
            {changeCount} unsaved change{changeCount === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
              Discard
            </Button>
            <Button size="sm" loading={saving} disabled={saving} onClick={save}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
