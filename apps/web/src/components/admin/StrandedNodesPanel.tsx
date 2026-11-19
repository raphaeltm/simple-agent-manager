import type { AdminStrandedNode } from '@simple-agent-manager/shared';
import { OPERATOR_NODE_DELETION_NOTE_MAX_CHARS } from '@simple-agent-manager/shared';
import { Button, Dialog, Input, Spinner, Textarea } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { attestOperatorNodeDeletion, fetchAdminStrandedNodes } from '../../lib/api';

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
  if (!reason) return 'SAM has not recorded why yet.';
  const first = reason.split(',')[0]?.trim() ?? reason;
  return BLOCK_REASON_TEXT[first] ?? reason;
}

function formatTime(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function providerName(node: AdminStrandedNode): string {
  return node.cloudProvider ?? 'the provider';
}

function RemoveNodeDialog({
  node,
  onClose,
  onRemoved,
}: {
  node: AdminStrandedNode;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const confirmId = useId();
  const noteId = useId();
  const [confirmation, setConfirmation] = useState('');
  const [note, setNote] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      attestOperatorNodeDeletion(node.id, { confirmation: confirmation.trim(), note: note.trim() }),
    onSuccess: () => {
      toast.success('Node removed');
      onRemoved();
    },
  });
  const ready = confirmation.trim() === node.id && note.trim().length > 0;
  const lookFor = node.providerInstanceId
    ? `server ${node.providerInstanceId}`
    : `a server named node-${node.id.toLowerCase()} or labelled node=${node.id.toLowerCase()}`;

  return (
    <Dialog isOpen onClose={onClose} maxWidth="md" aria-label="Remove a stuck node">
      <form
        className="grid gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !mutation.isPending) mutation.mutate();
        }}
      >
        <h2 className="m-0 text-base font-semibold text-fg-primary">Remove a stuck node</h2>
        <div className="grid gap-2 text-sm text-fg-secondary">
          <p className="m-0">
            Only continue if you checked {providerName(node)} yourself and there is no {lookFor}.
          </p>
          <p className="m-0">
            SAM will first ask {providerName(node)} with every credential it still has, and refuse
            if it finds the server. It will not delete anything at {providerName(node)}; it stops
            tracking this node and frees its capacity.
          </p>
          {!node.providerInstanceId && (
            <p className="m-0 text-fg-muted">No server ID was ever recorded for this node.</p>
          )}
        </div>
        <label className="grid gap-1.5 text-sm" htmlFor={confirmId}>
          <span className="font-medium text-fg-primary">Type the node ID to confirm</span>
          <span className="break-all font-mono text-xs text-fg-muted">{node.id}</span>
          <Input
            id={confirmId}
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm" htmlFor={noteId}>
          <span className="font-medium text-fg-primary">What did you check?</span>
          <Textarea
            id={noteId}
            value={note}
            rows={3}
            maxLength={OPERATOR_NODE_DELETION_NOTE_MAX_CHARS}
            placeholder="For example: searched the Hetzner console for the name and label, no server."
            onChange={(event) => setNote(event.target.value)}
          />
          <span className="text-xs text-fg-muted">
            Saved in the audit log with your name and the time. Do not paste secrets.
          </span>
        </label>
        {mutation.error && (
          <p role="alert" className="m-0 rounded-md bg-danger-tint p-3 text-sm text-danger-fg">
            {mutation.error instanceof Error ? mutation.error.message : 'Could not remove the node'}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!ready} loading={mutation.isPending}>
            Remove node
          </Button>
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
        <span className="break-words text-xs text-fg-muted">
          {providerName(node)}
          {node.vmLocation ? ` · ${node.vmLocation}` : ''} · {node.nodeRole} ·{' '}
          {node.providerInstanceId ? `server ${node.providerInstanceId}` : 'no server ID recorded'}{' '}
          · owner {node.ownerEmail ?? node.ownerUserId}
        </span>
        <span className="text-sm text-fg-secondary">
          {describeBlock(node.cleanupBlockedReason)}
        </span>
        <span className="text-xs text-fg-muted">
          {node.cleanupBlockedSince
            ? `Teardown failing since ${formatTime(node.cleanupBlockedSince)}`
            : 'No failed teardown recorded yet'}
          {` · last heartbeat ${formatTime(node.lastHeartbeatAt)}`}
        </span>
        {node.errorMessage && (
          <span
            className="line-clamp-2 break-words text-xs text-fg-muted"
            title={node.errorMessage}
          >
            {node.errorMessage}
          </span>
        )}
      </div>
      {node.cleanupBlockedSince ? (
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11 justify-self-start sm:min-h-0"
          onClick={() => onRemove(node)}
        >
          Server is gone…
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Admin → Infrastructure: nodes on SAM's own capacity that SAM cannot finish tearing down, and
 * the superadmin's way to remove one after checking the provider (POST
 * /api/admin/nodes/:id/operator-deletion). An owner removes nodes on their own cloud account from
 * the node page instead.
 */
export function StrandedNodesPanel() {
  const scope = useQueryScope();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<AdminStrandedNode | null>(null);
  const query = useQuery({
    queryKey: strandedNodeKeys.all(scope),
    queryFn: ({ signal }) => fetchAdminStrandedNodes(signal),
    enabled: Boolean(scope),
  });
  const nodes = query.data?.nodes ?? [];
  const total = query.data?.total ?? 0;

  return (
    <section
      className="glass-surface grid min-w-0 gap-4 rounded-lg p-4"
      aria-labelledby={headingId}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="sam-type-section-heading m-0 text-fg-primary">
            Stuck nodes
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            Nodes on SAM&apos;s capacity that SAM is trying, and failing, to tear down.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 border-transparent text-fg-muted hover:text-fg-primary"
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

      {query.isPending && !query.data ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : query.isError && !query.data ? (
        <p role="alert" className="m-0 text-sm text-danger-fg">
          Could not load stuck nodes.
        </p>
      ) : nodes.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">No stuck nodes.</p>
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
        <RemoveNodeDialog
          node={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            void queryClient.invalidateQueries({ queryKey: strandedNodeKeys.all(scope) });
          }}
        />
      )}
    </section>
  );
}
