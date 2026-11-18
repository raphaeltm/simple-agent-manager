import type { AdminProjectEventInspectorResponse } from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';

/** Skipped receipts have no durable row: disclose traffic coverage independently of the list. */
export function EventAdmissionDisclosure({
  admission,
}: {
  admission: AdminProjectEventInspectorResponse['admission'];
}) {
  return (
    <Pane className="min-w-0 p-4" data-testid="event-admission-disclosure">
      <h2 className="m-0 text-sm font-semibold text-fg-primary">CI event storage</h2>
      <p className="mt-2 text-sm text-fg-muted">
        {admission?.skipUnsubscribedGitHubCi === true
          ? 'Unmatched check_run, check_suite and workflow_run events are skipped. An empty event list does not mean there was no CI traffic.'
          : admission
            ? 'Full CI history is enabled. Unmatched CI events are stored.'
            : 'Admission counters are unavailable. An empty event list does not establish whether CI traffic arrived.'}
      </p>
      {admission && (
        <>
          <p className="mt-2 text-xs text-fg-muted">
            Current usage window since {new Date(admission.windowStart).toLocaleString()}. Memory
            only; resets on window flush or object eviction. Earlier traffic is not included.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-fg-primary">
            {Object.entries(admission.counts)
              .filter(([, count]) => count.skipped > 0)
              .map(([type, count]) => (
                <li key={type} className="break-words">
                  {type}: {count.skipped.toLocaleString()} skipped
                </li>
              ))}
          </ul>
          {!Object.values(admission.counts).some((count) => count.skipped > 0) && (
            <p className="mt-2 text-sm text-fg-muted">
              No skipped admissions observed in this window.
            </p>
          )}
          {admission.overflowCalls > 0 && (
            <p className="mt-2 text-sm text-fg-muted">
              {admission.overflowCalls.toLocaleString()} additional admissions are included only in
              overflow totals.
            </p>
          )}
        </>
      )}
    </Pane>
  );
}
