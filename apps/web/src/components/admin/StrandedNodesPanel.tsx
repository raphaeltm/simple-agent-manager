import type {
  AdminStrandedNode,
  CredentialProvider,
  ListAdminStrandedNodesResponse,
} from '@simple-agent-manager/shared';
import {
  OPERATOR_NODE_DELETION_NOTE_MAX_CHARS,
  PROVIDER_LABELS,
} from '@simple-agent-manager/shared';
import { Alert, Button, Dialog, Input, Spinner, Textarea } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { attestOperatorNodeDeletion, fetchAdminStrandedNodes } from '../../lib/api';
import { CopyableIdPill } from './CopyableIdPill';

const strandedNodeKeys = {
  all: (scope: string) => ['auth', scope, 'admin', 'stranded-nodes'] as const,
};

/** Plain-language versions of the teardown refusals a stuck node can carry. */
const BLOCK_REASON_TEXT: Record<string, string> = {
  teardown_credential_generation_changed:
    'The SAM credential this node was created with has been re-saved since, so SAM can no longer check whether its server exists.',
  teardown_allocation_unresolved:
    'Creating the server failed before SAM got its ID. SAM found no server, but will not assume none was made.',
  teardown_credential_unavailable:
    'The SAM credential this node was created with was removed or turned off.',
  teardown_instance_not_visible: 'No SAM credential can see this node’s server any more.',
  teardown_delete_refused: 'The provider refused to delete the server.',
  teardown_deletion_unconfirmed: 'SAM asked the provider to delete it, but never saw it finish.',
};

function describeBlock(reason: string | null): string {
  if (!reason) return 'SAM keeps failing to tear it down.';
  const first = reason.split(',')[0]?.trim() ?? reason;
  return BLOCK_REASON_TEXT[first] ?? reason;
}

function formatTime(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { timeZoneName: 'short' });
}

function providerName(node: AdminStrandedNode): string {
  const name = node.cloudProvider;
  if (!name) return 'the provider';
  return PROVIDER_LABELS[name as CredentialProvider] ?? name;
}

function RemoveNodeDialog({
  node,
  onClose,
  onRemoved,
}: {
  node: AdminStrandedNode;
  onClose: () => void;
  onRemoved: (nodeId: string) => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const introId = useId();
  const confirmId = useId();
  const confirmHintId = useId();
  const noteId = useId();
  const noteHintId = useId();
  const [confirmation, setConfirmation] = useState('');
  const [note, setNote] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const mutation = useMutation({
    mutationFn: () =>
      attestOperatorNodeDeletion(node.id, {
        confirmation: confirmation.trim(),
        expectedBlockedReason: node.cleanupBlockedReason,
        note: note.trim(),
      }),
    onSuccess: () => {
      toast.success(`Node ${node.id} removed`);
      onRemoved(node.id);
    },
    onError: () => {
      requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'nearest' }));
    },
  });
  const idMatches = confirmation.trim() === node.id;
  const ready = idMatches && note.trim().length > 0;
  const provider = providerName(node);
  const lowerId = node.id.toLowerCase();
  // A pending removal cannot be dismissed: Escape or a stray backdrop tap would hide its outcome.
  const guardedClose = useCallback(() => {
    if (!mutation.isPending) onClose();
  }, [mutation.isPending, onClose]);

  return (
    <Dialog
      isOpen
      onClose={guardedClose}
      maxWidth="md"
      aria-labelledby={titleId}
      aria-describedby={introId}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !mutation.isPending) mutation.mutate();
        }}
      >
        <h2 id={titleId} className="m-0 text-base font-semibold text-fg-primary">
          Remove a stuck node
        </h2>
        <div id={introId} className="grid gap-2 text-sm text-fg-secondary">
          <p className="m-0">Check {provider} first. Continue only if it has no server for:</p>
          <div className="flex flex-wrap gap-2">
            {node.providerInstanceId ? (
              <CopyableIdPill label="server" value={node.providerInstanceId} />
            ) : (
              <>
                <CopyableIdPill label="name" value={`node-${lowerId}`} />
                <CopyableIdPill label="label" value={`node=${lowerId}`} />
              </>
            )}
          </div>
          <p className="m-0 text-fg-muted">
            SAM checks again and refuses if it finds the server. Nothing is deleted at {provider}.
          </p>
        </div>
        <div className="grid gap-1.5 text-sm">
          <label htmlFor={confirmId} className="font-medium text-fg-primary">
            Type the node ID <span className="break-all font-mono text-xs">{node.id}</span>
          </label>
          <Input
            id={confirmId}
            value={confirmation}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={confirmHintId}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <span id={confirmHintId} aria-live="polite" className="text-xs text-fg-muted">
            {confirmation.trim() === ''
              ? 'Must match exactly.'
              : idMatches
                ? 'Matches.'
                : 'Does not match yet.'}
          </span>
        </div>
        <div className="grid gap-1.5 text-sm">
          <label htmlFor={noteId} className="font-medium text-fg-primary">
            What did you check?
          </label>
          <Textarea
            id={noteId}
            value={note}
            rows={3}
            maxLength={OPERATOR_NODE_DELETION_NOTE_MAX_CHARS}
            placeholder={`For example: searched the ${provider} console by name and label; nothing found.`}
            aria-describedby={noteHintId}
            onChange={(event) => setNote(event.target.value)}
          />
          <span id={noteHintId} className="text-xs text-fg-muted">
            Saved in the audit log with your name and the time. Do not paste secrets.
          </span>
        </div>
        <div className="sticky -bottom-6 -mx-6 -mb-6 grid gap-3 bg-surface px-6 pb-6 pt-3">
          {mutation.error && (
            <p
              ref={errorRef}
              role="alert"
              className="m-0 rounded-md bg-danger-tint p-3 text-sm text-danger-fg [overflow-wrap:anywhere]"
            >
              {mutation.error instanceof Error
                ? mutation.error.message
                : 'Could not remove the node'}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!ready} loading={mutation.isPending}>
              Remove node
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function StrandedNodeRow({
  node,
  onRemove,
}: {
  node: AdminStrandedNode;
  onRemove: (node: AdminStrandedNode) => void;
}) {
  return (
    <li className="grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4">
      <div className="grid min-w-0 gap-1">
        <span className="break-all font-mono text-sm text-fg-primary">{node.id}</span>
        <span className="text-xs text-fg-muted [overflow-wrap:anywhere]">
          {providerName(node)}
          {node.vmLocation ? ` · ${node.vmLocation}` : ''} · {node.nodeRole} ·{' '}
          {node.providerInstanceId ? `server ${node.providerInstanceId}` : 'no server ID recorded'}{' '}
          · owner {node.ownerEmail ?? node.ownerUserId}
        </span>
        <span className="text-sm text-fg-secondary">
          {describeBlock(node.cleanupBlockedReason)}
        </span>
        <span className="text-xs text-fg-muted">
          Failing since {formatTime(node.cleanupBlockedSince)} · last heartbeat{' '}
          {formatTime(node.lastHeartbeatAt)}
        </span>
        {node.errorMessage && (
          <details className="text-xs text-fg-muted">
            <summary className="cursor-pointer py-1">Last error</summary>
            <p className="m-0 mt-1 [overflow-wrap:anywhere]">{node.errorMessage}</p>
          </details>
        )}
      </div>
      {node.operatorRemovable ? (
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11 justify-self-start sm:min-h-0"
          aria-label={`Remove stuck node ${node.id}`}
          onClick={() => onRemove(node)}
        >
          Remove…
        </Button>
      ) : (
        <span className="max-w-56 text-xs text-fg-muted">
          The server may still exist. Check {providerName(node)} and resolve it there first.
        </span>
      )}
    </li>
  );
}

/**
 * Admin → Infrastructure: nodes on SAM's own capacity that SAM has failed to tear down, and the
 * superadmin's way to remove one after checking the provider (POST
 * /api/admin/nodes/:id/operator-deletion). An owner removes nodes on their own cloud account from
 * the node page instead.
 */
export function StrandedNodesPanel() {
  const scope = useQueryScope();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<AdminStrandedNode | null>(null);
  const query = useQuery({
    queryKey: strandedNodeKeys.all(scope),
    queryFn: ({ signal }) => fetchAdminStrandedNodes(signal),
    enabled: Boolean(scope),
  });
  const nodes = query.data?.nodes ?? [];
  const total = query.data?.total ?? 0;
  const closeDialog = useCallback(() => setRemoving(null), []);
  const handleRemoved = useCallback(
    (nodeId: string) => {
      setRemoving(null);
      // Drop the row at once so it cannot be tapped again while the refetch runs.
      queryClient.setQueryData<ListAdminStrandedNodesResponse>(
        strandedNodeKeys.all(scope),
        (current) =>
          current
            ? {
                nodes: current.nodes.filter((node) => node.id !== nodeId),
                total: Math.max(0, current.total - 1),
              }
            : current
      );
      void queryClient.invalidateQueries({ queryKey: strandedNodeKeys.all(scope) });
      headingRef.current?.focus();
    },
    [queryClient, scope]
  );

  return (
    <section
      className="glass-surface grid min-w-0 gap-4 rounded-lg p-4"
      aria-labelledby={headingId}
      aria-busy={query.isFetching}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="sam-type-section-heading m-0 text-fg-primary"
          >
            Stuck nodes
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            Nodes on SAM&apos;s capacity that SAM has failed to tear down.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 shrink-0 self-start border-transparent text-fg-muted hover:text-fg-primary sm:min-h-0"
          aria-label="Refresh stuck nodes"
          disabled={!scope}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            size={14}
            aria-hidden
            className={query.isFetching ? 'animate-spin' : undefined}
          />
          Refresh
        </Button>
      </div>

      {query.isError && query.data && (
        <Alert variant="warning">Could not refresh. Showing the last list.</Alert>
      )}

      {query.isPending && !query.data ? (
        <div className="flex justify-center py-4" role="status" aria-label="Loading stuck nodes">
          <Spinner size="sm" />
        </div>
      ) : query.isError && !query.data ? (
        <Alert variant="error">Could not load stuck nodes. Try Refresh.</Alert>
      ) : nodes.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">No stuck nodes. Every teardown is completing.</p>
      ) : (
        <>
          <ul className="m-0 grid list-none divide-y divide-border-default p-0">
            {nodes.map((node) => (
              <StrandedNodeRow key={node.id} node={node} onRemove={setRemoving} />
            ))}
          </ul>
          {total > nodes.length && (
            <p className="m-0 text-xs text-fg-muted">
              Showing the {nodes.length} oldest of {total} stuck nodes.
            </p>
          )}
        </>
      )}

      {removing && (
        <RemoveNodeDialog node={removing} onClose={closeDialog} onRemoved={handleRemoved} />
      )}
    </section>
  );
}
