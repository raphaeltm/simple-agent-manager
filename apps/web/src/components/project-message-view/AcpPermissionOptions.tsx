import { Button } from '@simple-agent-manager/ui';

import type { PermissionOption } from './useAcpPermissionCard';

const PINNED_RANK = (kind: string): number =>
  kind === 'allow_once' ? 0 : kind === 'reject_once' ? 1 : kind.startsWith('allow') ? 2 : 3;

/**
 * The decision buttons of a permission request: one button per option the agent supplied, never
 * an inferred one. One implementation, two layouts: `inline` inside the chat card, `pinned` as the
 * slim control row at the bottom of an inbox item (the command or evidence stays in the body).
 */
export function PermissionOptions({
  options,
  disabled,
  onChoose,
  layout = 'inline',
  busyOptionId = null,
}: {
  options: PermissionOption[];
  disabled: boolean;
  onChoose: (option: PermissionOption) => void;
  layout?: 'inline' | 'pinned';
  /** The option being sent, labelled "Sending…" (pinned layout). */
  busyOptionId?: string | null;
}) {
  const pinned = layout === 'pinned';
  // Pinned: the once-options share the first row and the broad grants ("always") follow, quieter,
  // so a quick tap never lands on the widest permission.
  const ordered = pinned
    ? [...options].sort((a, b) => PINNED_RANK(a.kind) - PINNED_RANK(b.kind))
    : options;
  return (
    <div
      className={
        pinned
          ? 'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2'
          : 'flex min-w-0 flex-wrap gap-2 pr-14'
      }
      aria-label="Permission options"
      data-testid="acp-permission-options"
    >
      {ordered.map((option) => {
        const reject = option.kind.startsWith('reject');
        const always = option.kind.endsWith('always');
        const variant =
          pinned && always
            ? 'ghost'
            : reject
              ? pinned
                ? 'secondary'
                : 'danger'
              : pinned && option.kind === 'allow_once'
                ? 'primary'
                : 'secondary';
        return (
          <Button
            key={option.id}
            type="button"
            size={pinned ? 'md' : 'sm'}
            variant={variant}
            className={`h-auto min-h-11 min-w-0 max-w-full !whitespace-normal break-words ${pinned ? 'text-center' : 'text-left'}`}
            disabled={disabled}
            onClick={() => onChoose(option)}
            data-option-id={option.id}
          >
            {busyOptionId === option.id ? 'Sending…' : option.name}
          </Button>
        );
      })}
    </div>
  );
}
