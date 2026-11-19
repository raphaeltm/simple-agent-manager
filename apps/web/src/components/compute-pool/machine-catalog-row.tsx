import { Button, Chip } from '@simple-agent-manager/ui';

import { formatOfferingNumber } from '../../lib/compute-pool-offerings';
import type { MachineRegionRow } from '../../lib/compute-pool-region-rows';

/**
 * Everything the machine table and the narrow-screen card list need to render one row, decided
 * once by MachineCatalogPane so both layouts behave the same.
 */
export interface CatalogRowView {
  inPool: (row: MachineRegionRow) => boolean;
  /** The person changed this row in the current edit; it applies on Save changes. */
  changed: (row: MachineRegionRow) => boolean;
  /** "Hetzner · Personal": account titles already start with the provider. */
  accountTitle: (row: MachineRegionRow) => string;
  /** Extra account context, such as the account being switched off. */
  accountNote: (row: MachineRegionRow) => string | null;
  /** "cx23 in Falkenstein", with the account when another account offers the same thing. */
  controlName: (row: MachineRegionRow) => string;
  cheapest: (row: MachineRegionRow) => boolean;
  selected: (row: MachineRegionRow) => boolean;
  selectable: (row: MachineRegionRow) => boolean;
  toggleSelected: (row: MachineRegionRow) => void;
  setInPool: (row: MachineRegionRow, inPool: boolean) => void;
}

export function rowSpecs(row: MachineRegionRow): string {
  return [
    `${formatOfferingNumber(row.vcpu, '')} vCPU`,
    `${formatOfferingNumber(row.ramGb, 'GB')}`,
    `${formatOfferingNumber(row.diskGb, 'GB')} disk`,
  ].join(' · ');
}

/** Add, Remove, or why the row cannot be added. */
export function RowAction({ row, view }: { row: MachineRegionRow; view: CatalogRowView }) {
  const inPool = view.inPool(row);
  if (!inPool && !row.canAllow) {
    return (
      <Chip size="sm" tone="warning" title={row.issue ?? undefined}>
        {row.issue ?? 'Unavailable'}
      </Chip>
    );
  }
  return (
    <Button
      size="sm"
      variant={inPool ? 'ghost' : 'raised'}
      aria-label={`${inPool ? 'Remove' : 'Add'} ${view.controlName(row)}`}
      onClick={() => view.setInPool(row, !inPool)}
    >
      {inPool ? 'Remove' : 'Add'}
    </Button>
  );
}

/** Marks a row changed in this edit, in words, so the pending state is not colour alone. */
export function UnsavedTag({ row, view }: { row: MachineRegionRow; view: CatalogRowView }) {
  if (!view.changed(row)) return null;
  return (
    <Chip size="sm" tone="info">
      {view.inPool(row) ? 'Adding on save' : 'Removing on save'}
    </Chip>
  );
}

export function RowCheckbox({
  row,
  view,
  className,
}: {
  row: MachineRegionRow;
  view: CatalogRowView;
  className: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={`Select ${view.controlName(row)}`}
      className={`${className} accent-[var(--sam-color-focus-ring)]`}
      checked={view.selected(row)}
      disabled={!view.selectable(row)}
      onChange={() => view.toggleSelected(row)}
    />
  );
}

export function AccountLine({ row, view }: { row: MachineRegionRow; view: CatalogRowView }) {
  const note = view.accountNote(row);
  return (
    <>
      {view.accountTitle(row)}
      {note ? ` · ${note}` : ''}
    </>
  );
}
