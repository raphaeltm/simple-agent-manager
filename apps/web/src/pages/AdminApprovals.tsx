import type { OperationsActionApproval } from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';

import {
  operationsApprovalKeys,
  useDecideOperationsApproval,
} from '../components/operations-approvals/approval-queries';
import { ApprovalItem } from '../components/operations-approvals/ApprovalItem';
import { useQueryScope } from '../hooks/useQueryScope';
import { fetchOperationsApprovals } from '../lib/api';

/**
 * Admin → Approvals: a superadmin approves or denies what an Operations-project agent asked to
 * do. The decision is the server-side record `ops_execute_action` checks, and it is delivered to
 * the agent's session as a new prompt.
 */
export function AdminApprovals() {
  const scope = useQueryScope();
  const [params] = useSearchParams();
  const highlightedId = params.get('approval');
  const query = useQuery({
    queryKey: operationsApprovalKeys.all(scope),
    queryFn: ({ signal }) => fetchOperationsApprovals(signal),
    enabled: Boolean(scope),
  });
  const decide = useDecideOperationsApproval(scope);

  const approvals = query.data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === 'pending');
  const settled = approvals.filter((a) => a.status !== 'pending');
  const decidingFor = (id: string) =>
    decide.isPending && decide.variables?.id === id ? decide.variables.decision : null;

  const renderList = (items: OperationsActionApproval[]) => (
    <div className="divide-y divide-border-default">
      {items.map((approval) => (
        <ApprovalItem
          key={approval.id}
          approval={approval}
          highlighted={approval.id === highlightedId}
          deciding={decidingFor(approval.id)}
          onDecide={(decision) => decide.mutate({ id: approval.id, decision })}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-3">
          <span className="text-sm font-medium text-fg-primary" aria-live="polite">
            Waiting for you{pending.length > 0 ? ` (${pending.length})` : ''}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Refresh
          </Button>
        </div>
        {decide.error && (
          <div role="alert" className="border-b border-border-default px-4 py-3">
            <Body className="text-danger-fg">{decide.error.message}</Body>
          </div>
        )}
        {query.isPending ? (
          <div className="flex justify-center p-8">
            <Spinner size="lg" />
          </div>
        ) : query.error && approvals.length === 0 ? (
          <div className="p-6 text-center">
            <Body className="text-danger-fg">{query.error.message}</Body>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : pending.length === 0 ? (
          <div className="p-8 text-center">
            <Body className="text-fg-muted">
              Nothing to approve. Operations agents ask here before they delete, restart, sleep or
              cancel anything.
            </Body>
          </div>
        ) : (
          renderList(pending)
        )}
      </Card>

      {settled.length > 0 && (
        <Card>
          <div className="border-b border-border-default px-4 py-3">
            <span className="text-sm font-medium text-fg-primary">Recent decisions</span>
          </div>
          {renderList(settled)}
        </Card>
      )}
    </div>
  );
}
