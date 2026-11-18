import type { MachineRegionRow } from '../../lib/compute-pool-region-rows';
import {
  AccountLine,
  type CatalogRowView,
  RowAction,
  RowCheckbox,
  rowSpecs,
  UnsavedTag,
} from './machine-catalog-row';

/** The machine list on narrow screens and panes: one card per machine × region. */
export function MachineCatalogCards({
  rows,
  view,
}: {
  rows: MachineRegionRow[];
  view: CatalogRowView;
}) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {rows.map((row) => (
        <li
          key={row.key}
          className={`flex min-w-0 items-start gap-3 rounded-md border border-border-default p-3 ${
            view.inPool(row) ? 'bg-[var(--sam-status-success-bg)]' : 'bg-inset'
          }`}
        >
          <RowCheckbox row={row} view={view} className="mt-1 h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-sm text-fg-primary [overflow-wrap:anywhere]">
              <span className="font-mono">{row.sku}</span> · {row.regionLabel}
            </p>
            <p className="m-0 text-xs text-fg-muted [overflow-wrap:anywhere]">
              <AccountLine row={row} view={view} />
            </p>
            <p className="m-0 text-xs text-fg-muted">{rowSpecs(row)}</p>
            <p className="m-0 text-xs text-fg-primary">
              {row.priceLabel ?? 'Price unavailable'}
              {view.cheapest(row) ? ' · cheapest region' : ''}
            </p>
            <UnsavedTag row={row} view={view} />
          </div>
          <div className="shrink-0">
            <RowAction row={row} view={view} />
          </div>
        </li>
      ))}
    </ul>
  );
}
