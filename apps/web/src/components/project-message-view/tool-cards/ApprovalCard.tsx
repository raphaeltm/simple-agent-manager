import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { Body, Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { type FC, useMemo } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { fetchOperationsApproval } from '../../../lib/api';
import { useAuth } from '../../AuthProvider';
import {
  operationsApprovalKeys,
  useDecideOperationsApproval,
} from '../../operations-approvals/approval-queries';
import { ApprovalItem } from '../../operations-approvals/ApprovalItem';
import { extractApprovalId } from './approval-card-data';

export interface ApprovalCardProps {
  item: ToolCallItem;
  /** Project of the conversation. Approve / Deny only show for approvals requested from it. */
  projectId?: string;
}

/**
 * How often an open card re-reads an approval that can still change (pending: decided elsewhere
 * or expires; approved: the agent runs it). TanStack pauses this while the tab is hidden.
 * Override via VITE_APPROVAL_CARD_REFRESH_MS.
 */
const DEFAULT_APPROVAL_CARD_REFRESH_MS = 15_000;
const APPROVAL_CARD_REFRESH_MS = import.meta.env.VITE_APPROVAL_CARD_REFRESH_MS
  ? parseInt(import.meta.env.VITE_APPROVAL_CARD_REFRESH_MS, 10)
  : DEFAULT_APPROVAL_CARD_REFRESH_MS;
const CHANGING_STATUSES = new Set(['pending', 'approved']);

const CARD_CLASS = 'glass-surface my-1 rounded-md border border-border-default';

function adminApprovalsHref(approvalId: string): string {
  return `/admin/approvals?approval=${encodeURIComponent(approvalId)}`;
}

/**
 * Renders an `ops_request_action` tool call as the approval it created, so a superadmin can
 * approve or deny without leaving the conversation. Everything shown comes from the server's
 * approval record; the transcript supplies only the approval ID. The decision goes through the
 * same endpoint as Admin → Approvals and reaches the agent as a new prompt.
 */
export const ApprovalCard: FC<ApprovalCardProps> = ({ item, projectId }) => {
  const approvalId = useMemo(() => extractApprovalId(item), [item]);
  const { isSuperadmin } = useAuth();
  const scope = useQueryScope();
  const query = useQuery({
    queryKey: operationsApprovalKeys.detail(scope, approvalId ?? ''),
    queryFn: ({ signal }) => fetchOperationsApproval(approvalId as string, signal),
    enabled: Boolean(scope && approvalId && isSuperadmin),
    refetchInterval: (q) =>
      CHANGING_STATUSES.has(q.state.data?.approval.status ?? '') ? APPROVAL_CARD_REFRESH_MS : false,
  });
  const decide = useDecideOperationsApproval(scope);

  if (!approvalId) return null;

  if (!isSuperadmin) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`} role="note">
        <ShieldCheck size={18} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 text-sm text-fg-muted">
          Approval requested. A superadmin decides whether the agent may go ahead.
        </div>
      </div>
    );
  }

  const approval = query.data?.approval;

  if (!approval) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`}>
        {query.error ? (
          <>
            <div className="min-w-0 flex-1 text-sm text-danger-fg" role="alert">
              Couldn&apos;t load this approval: {query.error.message}
            </div>
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2.5" role="status">
            <Spinner size="sm" />
            <span className="text-sm text-fg-muted">Loading approval…</span>
          </div>
        )}
      </div>
    );
  }

  // An approval from another project is still shown (the server record is the truth), but it is
  // decided where its own conversation is, or in Admin → Approvals. Without a known project the
  // buttons stay hidden (fail closed).
  const fromThisConversation = Boolean(projectId) && approval.requestingProjectId === projectId;
  const deciding =
    decide.isPending && decide.variables?.id === approval.id ? decide.variables.decision : null;
  const notificationUnconfirmed =
    decide.data?.approval.id === approval.id && decide.data.delivered === false;

  return (
    <div className={CARD_CLASS} data-testid="approval-card">
      <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-2">
        <span className="flex items-center gap-2 text-xs font-medium text-fg-muted">
          <ShieldCheck size={14} aria-hidden="true" />
          Approval request
        </span>
        <Link to={adminApprovalsHref(approval.id)} className="text-xs text-accent hover:underline">
          Open in Approvals
        </Link>
      </div>
      {decide.error && (
        <div role="alert" className="border-b border-border-default px-4 py-2">
          <Body className="text-sm text-danger-fg">{decide.error.message}</Body>
        </div>
      )}
      {notificationUnconfirmed && (
        <div role="alert" className="border-b border-border-default px-4 py-2">
          <Body className="text-sm text-warning-fg">
            Decision saved, but the agent was not confirmed to have been told. Tell it in this chat
            before it relies on this decision.
          </Body>
        </div>
      )}
      {!fromThisConversation && (
        <div className="px-4 pt-3 text-xs text-fg-muted">
          Decide this approval in Approvals: it was not requested from this project.
        </div>
      )}
      <ApprovalItem
        approval={approval}
        canDecide={fromThisConversation}
        deciding={deciding}
        onDecide={(decision) => decide.mutate({ id: approval.id, decision })}
      />
    </div>
  );
};
