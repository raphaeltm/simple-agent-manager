import type {
  PlatformInfraAssociationReason,
  PlatformInfraNodeSummary,
  PlatformInfraUserOption,
} from '@simple-agent-manager/shared';
import { Alert, Body, Button, Card, EmptyState, Select, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { Server, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  deleteAdminPlatformInfraAssociation,
  fetchAdminPlatformInfra,
  upsertAdminPlatformInfraAssociation,
} from '../lib/api';

type AssociationFilter = 'all' | 'assigned' | 'unassigned';
type DraftState = Record<string, { userId: string; reason: PlatformInfraAssociationReason }>;

const REASON_OPTIONS: Array<{ value: PlatformInfraAssociationReason; label: string }> = [
  { value: 'trial', label: 'Trial' },
  { value: 'support', label: 'Support' },
  { value: 'migration', label: 'Migration' },
  { value: 'other', label: 'Other' },
];

function formatRelativeDate(iso: string): string {
  const created = new Date(iso).getTime();
  const diffMs = Date.now() - created;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function buildDrafts(nodes: PlatformInfraNodeSummary[]): DraftState {
  return Object.fromEntries(
    nodes.map((node) => [
      node.id,
      {
        userId: node.association?.userId ?? '',
        reason: node.association?.reason ?? 'trial',
      },
    ]),
  );
}

function NodeCard({
  node,
  users,
  draft,
  loading,
  onDraftChange,
  onAssign,
  onClear,
}: {
  node: PlatformInfraNodeSummary;
  users: PlatformInfraUserOption[];
  draft: { userId: string; reason: PlatformInfraAssociationReason };
  loading: boolean;
  onDraftChange: (next: { userId: string; reason: PlatformInfraAssociationReason }) => void;
  onAssign: () => void;
  onClear: () => void;
}) {
  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="m-0 text-base font-semibold text-fg-primary truncate">{node.name}</h3>
            <StatusBadge status={node.status} />
            <StatusBadge status={node.healthStatus} />
          </div>
          <Body className="text-fg-muted text-sm mt-1">
            {node.cloudProvider ?? 'Unknown provider'} · {node.vmSize} · {node.vmLocation} · created {formatRelativeDate(node.createdAt)}
          </Body>
        </div>
        <div className="text-right shrink-0">
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Source</Body>
          <Body className="text-sm font-medium text-fg-primary capitalize">{node.credentialSource ?? 'unknown'}</Body>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-sm bg-inset p-3">
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Workspaces</Body>
          <Body className="text-lg font-semibold text-fg-primary">{node.workspaceCount}</Body>
        </div>
        <div className="rounded-sm bg-inset p-3">
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Active</Body>
          <Body className="text-lg font-semibold text-fg-primary">{node.activeWorkspaceCount}</Body>
        </div>
        <div className="rounded-sm bg-inset p-3">
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Owner</Body>
          <Body className="text-sm font-medium text-fg-primary font-mono">{node.ownerUserId}</Body>
        </div>
        <div className="rounded-sm bg-inset p-3">
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Last heartbeat</Body>
          <Body className="text-sm font-medium text-fg-primary">
            {node.lastHeartbeatAt ? formatRelativeDate(node.lastHeartbeatAt) : 'Never'}
          </Body>
        </div>
      </div>

      {node.trial && (
        <div className="rounded-sm border border-border-default p-3">
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Trial context</Body>
          <Body className="text-sm font-medium text-fg-primary">
            {node.trial.repoOwner}/{node.trial.repoName}
          </Body>
          <Body className="text-fg-muted text-sm">
            Trial {node.trial.id} · {node.trial.status}
            {node.trial.claimedByUserId ? ` · claimed by ${node.trial.claimedByUserId}` : ''}
          </Body>
        </div>
      )}

      <div className="rounded-sm border border-border-default p-3 flex flex-col gap-3">
        <div>
          <Body className="text-fg-muted text-xs uppercase tracking-wide">Association</Body>
          {node.association ? (
            <Body className="text-sm text-fg-primary">
              {node.association.userName || node.association.userEmail} · {node.association.reason}
            </Body>
          ) : (
            <Body className="text-sm text-fg-muted">No user associated</Body>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_auto_auto]">
          <Select
            value={draft.userId}
            aria-label={`Associate ${node.name} with user`}
            onChange={(event) => onDraftChange({ ...draft, userId: event.target.value })}
          >
            <option value="">Select user</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name ? `${user.name} (${user.email})` : user.email}
              </option>
            ))}
          </Select>

          <Select
            value={draft.reason}
            aria-label={`Association reason for ${node.name}`}
            onChange={(event) => onDraftChange({ ...draft, reason: event.target.value as PlatformInfraAssociationReason })}
          >
            {REASON_OPTIONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </Select>

          <Button onClick={onAssign} disabled={!draft.userId || loading} loading={loading}>
            Save
          </Button>

          <Button variant="secondary" onClick={onClear} disabled={!node.association || loading}>
            Clear
          </Button>
        </div>
      </div>

      {node.errorMessage && (
        <Alert variant="error">
          {node.errorMessage}
        </Alert>
      )}
    </Card>
  );
}

export function AdminPlatformInfra() {
  const [nodes, setNodes] = useState<PlatformInfraNodeSummary[]>([]);
  const [users, setUsers] = useState<PlatformInfraUserOption[]>([]);
  const [drafts, setDrafts] = useState<DraftState>({});
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [savingNodeId, setSavingNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [associationFilter, setAssociationFilter] = useState<AssociationFilter>('all');
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      setError(null);
      const response = await fetchAdminPlatformInfra();
      setNodes(response.nodes);
      setUsers(response.users);
      setDrafts((currentDrafts) => {
        const nextDrafts = buildDrafts(response.nodes);
        return Object.keys(currentDrafts).length === 0 ? nextDrafts : { ...nextDrafts, ...currentDrafts };
      });
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load platform infrastructure');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const visibleNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (associationFilter === 'assigned') return Boolean(node.association);
      if (associationFilter === 'unassigned') return !node.association;
      return true;
    });
  }, [associationFilter, nodes]);

  const updateDraft = useCallback((nodeId: string, next: { userId: string; reason: PlatformInfraAssociationReason }) => {
    setDrafts((current) => ({ ...current, [nodeId]: next }));
  }, []);

  const handleAssign = useCallback(async (nodeId: string) => {
    const draft = drafts[nodeId];
    if (!draft?.userId) return;
    setSavingNodeId(nodeId);
    try {
      setError(null);
      await upsertAdminPlatformInfraAssociation(nodeId, draft);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save association');
    } finally {
      setSavingNodeId(null);
    }
  }, [drafts, loadData]);

  const handleClear = useCallback(async (nodeId: string) => {
    setSavingNodeId(nodeId);
    try {
      setError(null);
      await deleteAdminPlatformInfraAssociation(nodeId);
      await loadData();
      setDrafts((current) => ({
        ...current,
        [nodeId]: { userId: '', reason: 'trial' },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear association');
    } finally {
      setSavingNodeId(null);
    }
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-fg-muted" aria-hidden="true" />
            <h2 className="m-0 text-lg font-semibold text-fg-primary">Platform Infrastructure</h2>
            {isRefreshing && <Spinner size="sm" />}
          </div>
          <Body className="text-fg-muted text-sm mt-1">
            Monitor platform-funded nodes and associate them with users for trial, support, or migration workflows.
          </Body>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="rounded-sm bg-inset px-3 py-2 min-w-28">
            <Body className="text-fg-muted text-xs uppercase tracking-wide">Nodes</Body>
            <Body className="text-sm font-semibold text-fg-primary">{nodes.length}</Body>
          </div>
          <div className="rounded-sm bg-inset px-3 py-2 min-w-28">
            <Body className="text-fg-muted text-xs uppercase tracking-wide">Assigned</Body>
            <Body className="text-sm font-semibold text-fg-primary">{nodes.filter((node) => node.association).length}</Body>
          </div>
          <div className="rounded-sm bg-inset px-3 py-2 min-w-28">
            <Body className="text-fg-muted text-xs uppercase tracking-wide">Trials</Body>
            <Body className="text-sm font-semibold text-fg-primary">{nodes.filter((node) => node.trial).length}</Body>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Select
          value={associationFilter}
          onChange={(event) => setAssociationFilter(event.target.value as AssociationFilter)}
          aria-label="Filter platform nodes by association"
        >
          <option value="all">All nodes</option>
          <option value="assigned">Assigned</option>
          <option value="unassigned">Unassigned</option>
        </Select>
      </div>

      {visibleNodes.length === 0 ? (
        <EmptyState
          icon={<Users size={48} />}
          heading="No platform-managed nodes"
          description="No platform-funded nodes match the current filter."
        />
      ) : (
        <div className="grid gap-4">
          {visibleNodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              users={users}
              draft={drafts[node.id] ?? { userId: node.association?.userId ?? '', reason: node.association?.reason ?? 'trial' }}
              loading={savingNodeId === node.id}
              onDraftChange={(next) => updateDraft(node.id, next)}
              onAssign={() => void handleAssign(node.id)}
              onClear={() => void handleClear(node.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
