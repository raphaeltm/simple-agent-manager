import type { SizeInfo, VMSize } from '@simple-agent-manager/shared';
import type { FC } from 'react';

interface VmSizeCardProps {
  /** Abstract size key (small / medium / large). */
  size: VMSize;
  /** Provider-specific details from the catalog (null = fallback). */
  sizeInfo: SizeInfo | null;
  /** Whether this card is the currently selected option. */
  selected: boolean;
  /** Called when the user clicks the card. */
  onClick: () => void;
  /** Disables interaction (e.g. while saving). */
  disabled?: boolean;
  /** Use a more compact layout (e.g. in a drawer). */
  compact?: boolean;
}

const LABELS: Record<VMSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

/**
 * Standardized VM size selection card used across all surfaces.
 *
 * When catalog data is available (`sizeInfo`), displays the exact server type,
 * vCPU count, RAM, and price. Falls back to the abstract label when catalog
 * data is unavailable.
 */
export const VmSizeCard: FC<VmSizeCardProps> = ({
  size,
  sizeInfo,
  selected,
  onClick,
  disabled = false,
  compact = false,
}) => {
  const label = LABELS[size];

  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-sm border text-left transition ${
        compact ? 'p-2' : 'p-3'
      } ${
        selected
          ? 'border-accent bg-accent-tint'
          : 'border-border-default bg-surface hover:border-accent/60'
      } ${disabled ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
    >
      <span className="block text-sm font-semibold text-fg-primary">{label}</span>
      {sizeInfo ? (
        <>
          <span className="mt-0.5 block text-xs text-fg-muted">
            {sizeInfo.type} &middot; {sizeInfo.vcpu} vCPU &middot; {sizeInfo.ramGb} GB RAM
          </span>
          <span className="mt-0.5 block text-xs text-fg-muted">
            {sizeInfo.storageGb} GB storage &middot; {sizeInfo.price}
          </span>
        </>
      ) : (
        <span className="mt-0.5 block text-xs text-fg-muted">Exact specs unavailable</span>
      )}
    </button>
  );
};
