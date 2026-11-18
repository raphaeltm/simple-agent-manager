import { Alert, Button } from '@simple-agent-manager/ui';

import { requestErrorText } from './sam-receipts';

/** A failed load with its recovery action on a spaced row of its own. */
export function RetryAlert({
  error,
  fallback,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="error">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span>{requestErrorText(error, fallback)}</span>
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Alert>
  );
}
