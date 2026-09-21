/**
 * Prototype-only visual tokens for the node resource concepts.
 *
 * Every hex below was validated with the dataviz skill's `validate_palette.js`
 * against the real dark chart surface (`--sam-color-bg-surface` = #13201d):
 *
 *   categorical trio  #16a34a,#3b82f6,#ec4899   → ALL CHECKS PASS (--pairs all)
 *   green ordinal     #86efac…#15803d           → ALL CHECKS PASS (--ordinal)
 *   blue  ordinal     #bfdbfe…#2563eb           → ALL CHECKS PASS (--ordinal)
 *   pink  ordinal     #f9a8d4…#be185d           → ALL CHECKS PASS (--ordinal)
 *
 * Rejected on the way here: #60a5fa + #c084fc (deutan ΔE 1.3) and the repo's own
 * --sam-admin-chart-series-1..6 set (fails CVD separation and the lightness band).
 *
 * Severity uses the SAM status tokens, never the dimension hues — status colour is
 * reserved for state, per the dataviz rules.
 */

export type DimensionKey = 'cpu' | 'memory' | 'disk';

export interface DimensionSpec {
  key: DimensionKey;
  /** Short label used on rails and column heads. */
  label: string;
  /** Long label used in legends and aria text. */
  longLabel: string;
  /** Validated categorical hue. */
  hue: string;
  /**
   * The dimension's 5 validated steps, stored in TENANT-ASSIGNMENT order rather
   * than light→dark order: index 0 is the canonical hue, then the ramp alternates
   * outward. Two consequences, both deliberate:
   *   - a node with one tenant fills in the saturated base hue, so a 100%-full rail
   *     cannot render pale while its readout says 100% in danger red;
   *   - neighbouring segments land far apart in lightness, which is exactly what
   *     telling two adjacent fills apart needs.
   * Sorted light→dark the same five values are `validate_palette.js --ordinal` clean.
   */
  ramp: readonly string[];
}

const CPU_DIMENSION: DimensionSpec = {
  key: 'cpu',
  label: 'vCPU',
  longLabel: 'vCPU',
  hue: '#16a34a',
  // light→dark: #86efac #4ade80 #22c55e #16a34a #15803d
  ramp: ['#16a34a', '#4ade80', '#15803d', '#22c55e', '#86efac'],
};

const MEMORY_DIMENSION: DimensionSpec = {
  key: 'memory',
  label: 'RAM',
  longLabel: 'Memory',
  hue: '#3b82f6',
  // light→dark: #bfdbfe #93c5fd #60a5fa #3b82f6 #2563eb
  ramp: ['#3b82f6', '#93c5fd', '#2563eb', '#60a5fa', '#bfdbfe'],
};

const DISK_DIMENSION: DimensionSpec = {
  key: 'disk',
  label: 'Disk',
  longLabel: 'Disk',
  hue: '#ec4899',
  // light→dark: #f9a8d4 #f472b6 #ec4899 #db2777 #be185d
  ramp: ['#ec4899', '#f9a8d4', '#be185d', '#f472b6', '#db2777'],
};

/**
 * Compressible resources degrade under contention; non-compressible ones fail.
 * The scheduler already draws this line (see the comment above
 * `measuredAdmissionDiagnostic` in apps/api/src/services/workspace-resource-capacity.ts),
 * and the UI must not erase it: a workspace bursting past its CPU reservation is the
 * kernel time-slicing, while one bursting past its memory reservation is an OOM
 * waiting to happen. They must not wear the same colour.
 */
export function isCompressible(key: DimensionKey): boolean {
  return key === 'cpu';
}

export const DIMENSIONS: readonly DimensionSpec[] = [
  CPU_DIMENSION,
  MEMORY_DIMENSION,
  DISK_DIMENSION,
];

export const DIMENSION_BY_KEY: Record<DimensionKey, DimensionSpec> = {
  cpu: CPU_DIMENSION,
  memory: MEMORY_DIMENSION,
  disk: DISK_DIMENSION,
};

/**
 * Severity thresholds match the ones the production node UI already uses
 * (MiniMetricBadge warnAt 60 / critAt 85), so the prototype cannot teach a
 * different reading of the same numbers.
 */
export const WARN_AT = 60;
export const CRIT_AT = 85;

export type Severity = 'ok' | 'warn' | 'crit';

export function severityOf(percent: number): Severity {
  if (percent >= CRIT_AT) return 'crit';
  if (percent >= WARN_AT) return 'warn';
  return 'ok';
}

/** Status tokens verified present in packages/ui/src/tokens/theme.css. */
export const SEVERITY_FG: Record<Severity, string> = {
  ok: 'var(--sam-color-fg-primary)',
  warn: 'var(--sam-color-warning-fg)',
  crit: 'var(--sam-color-danger-fg)',
};

export const SEVERITY_TINT: Record<Severity, string> = {
  ok: 'var(--sam-color-success-tint)',
  warn: 'var(--sam-color-warning-tint)',
  crit: 'var(--sam-color-danger-tint)',
};

/** Track colour behind every mark — also the colour of the 2px surface gaps. */
export const TRACK = 'var(--sam-color-bg-inset)';
/** The gap is drawn in the card surface so marks are separated by air, not a stroke. */
export const GAP = 'var(--sam-glass-nested-bg, var(--sam-color-bg-surface))';

/**
 * Per-workspace segment colour: walk the dimension's assignment-ordered ramp by
 * tenant index. Beyond the ramp length the 2px surface gap plus the numbered legend
 * chip carry identity, so the ramp cycles rather than inventing an unvalidated hue.
 */
export function segmentColor(dimension: DimensionSpec, index: number): string {
  return dimension.ramp[index % dimension.ramp.length] ?? dimension.hue;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** 4200 millicores → "4.2 vCPU". Whole values lose the decimal: 2000 → "2 vCPU". */
export function formatVcpu(cpuMillis: number, withUnit = true): string {
  const vcpu = cpuMillis / 1000;
  const value = Number.isInteger(vcpu) ? String(vcpu) : vcpu.toFixed(1);
  return withUnit ? `${value} vCPU` : value;
}

/** MB → "820 MB" under 1 GB, "3.5 GB" above. */
export function formatMemory(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb >= 100 ? Math.round(gb) : Number(gb.toFixed(1))} GB`;
}

/** MB → "36 GB" / "2 GB"; disk is always talked about in GB in this product. */
export function formatDisk(mb: number): string {
  const gb = mb / 1024;
  if (gb < 10) return `${Number(gb.toFixed(1))} GB`;
  return `${Math.round(gb)} GB`;
}

export function formatByDimension(key: DimensionKey, value: number): string {
  if (key === 'cpu') return formatVcpu(value);
  if (key === 'memory') return formatMemory(value);
  return formatDisk(value);
}

/** "12" / "8.4" — percentages never get a decimal above 10%. */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '—';
  if (percent >= 10) return String(Math.round(percent));
  return String(Number(percent.toFixed(1)));
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
