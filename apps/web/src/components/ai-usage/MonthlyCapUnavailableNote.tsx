import { Body } from '@simple-agent-manager/ui';
import { Info } from 'lucide-react';

import { formatCost } from './format';

/**
 * Shown where a monthly AI dollar cap would be, when this installation cannot read Cloudflare
 * AI Gateway cost data (the only price source; `isMonthlyCostCapAvailable` in the API), so a cap
 * could be set but never enforced. One component for the user and admin pages so the two say
 * the same thing.
 */
export function MonthlyCapUnavailableNote({
  audience,
  storedCapUsd = null,
  testId,
}: {
  audience: 'user' | 'admin';
  /** A cap saved earlier, which is not enforced here and is cleared by the next save. */
  storedCapUsd?: number | null;
  testId: string;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border-default bg-surface p-3"
      data-testid={testId}
    >
      <Info className="w-4 h-4 text-fg-muted flex-shrink-0 mt-0.5" aria-hidden="true" />
      <Body className="text-fg-muted text-sm m-0 min-w-0 break-words">
        <span className="font-medium text-fg-primary">
          Monthly cost caps are not available on this installation.
        </span>{' '}
        SAM cannot read Cloudflare AI Gateway cost data here
        {audience === 'admin'
          ? ' (it needs AI_GATEWAY_ID, CF_ACCOUNT_ID and CF_API_TOKEN), so users cannot set a monthly cap.'
          : '.'}{' '}
        Daily token limits still apply.
        {storedCapUsd !== null && storedCapUsd > 0 && (
          <>
            {' '}
            Your saved cap of {formatCost(storedCapUsd)} is not enforced here; saving these settings
            clears it.
          </>
        )}
      </Body>
    </div>
  );
}
