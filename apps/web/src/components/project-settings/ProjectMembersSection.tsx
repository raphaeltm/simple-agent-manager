import type {
  ProjectAccessRequestResponse,
  ProjectCredentialAttributionHealthSummary,
  ProjectInviteGithubAccessStatus,
  ProjectInviteLinkResponse,
  ProjectMemberOffboardingAction,
  ProjectMemberOffboardingPreviewResponse,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourcePreview,
  ProjectMemberResponse,
  ProjectMembersResponse,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  Check,
  Copy,
  Crown,
  DoorOpen,
  Link as LinkIcon,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { useToast } from '../../hooks/useToast';
import {
  applyProjectMemberOffboarding,
  approveProjectAccessRequest,
  createProjectInviteLink,
  denyProjectAccessRequest,
  getProjectCredentialAttributionHealth,
  getProjectMembers,
  previewProjectMemberOffboarding,
  revokeProjectInviteLink,
  transferProjectOwnership,
} from '../../lib/api';
import { ApiClientError } from '../../lib/api/client';
import { useAuth } from '../AuthProvider';
import { ConfirmDialog } from '../ConfirmDialog';

const GITHUB_STATUS_META: Record<ProjectInviteGithubAccessStatus, { label: string; className: string }> = {
  unchecked: {
    label: 'unchecked',
    className: 'text-fg-muted bg-inset',
  },
  verified: {
    label: 'GitHub verified',
    className: 'text-success bg-[color-mix(in_srgb,var(--sam-color-success)_14%,transparent)]',
  },
  'missing-token': {
    label: 'GitHub sign-in needed',
    className: 'text-warning bg-[color-mix(in_srgb,var(--sam-color-warning)_14%,transparent)]',
  },
  'no-access': {
    label: 'no repo access',
    className: 'text-danger bg-[color-mix(in_srgb,var(--sam-color-danger)_14%,transparent)]',
  },
  'unsupported-provider': {
    label: 'not required',
    className: 'text-fg-muted bg-inset',
  },
  'check-failed': {
    label: 'check failed',
    className: 'text-warning bg-[color-mix(in_srgb,var(--sam-color-warning)_14%,transparent)]',
  },
};

function userLabel(member: Pick<ProjectMemberResponse, 'userId' | 'user'>): string {
  return member.user?.name || member.user?.email || member.userId;
}

function requestUserLabel(request: ProjectAccessRequestResponse): string {
  return request.requester?.name || request.requester?.email || request.requesterUserId;
}

function formatDate(value: string | null): string {
  if (!value) return 'never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detailString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasRemainingProjectCoverage(resource: ProjectMemberOffboardingResourcePreview): boolean {
  const coverage = resource.details.remainingProjectCoverage;
  if (!coverage) return false;
  if (isRecord(coverage)) {
    return Object.values(coverage).some(Boolean);
  }
  return Boolean(coverage);
}

function offboardingResourceKey(resource: ProjectMemberOffboardingResourcePreview): string {
  return `${resource.resourceKind}:${resource.resourceId}`;
}

function defaultOffboardingAction(
  resource: ProjectMemberOffboardingResourcePreview
): ProjectMemberOffboardingAction {
  return resource.availableActions.includes('break_and_flag')
    ? 'break_and_flag'
    : resource.availableActions[0] ?? 'defer_removal';
}

function resourceKindLabel(kind: ProjectMemberOffboardingResourceKind): string {
  switch (kind) {
    case 'trigger':
      return 'Triggers';
    case 'task_tree':
      return 'Running tasks';
    case 'node':
      return 'Nodes';
    case 'deployment_environment':
      return 'Deployments';
    case 'project_attachment':
      return 'Project credential attachments';
    default:
      return 'Resources';
  }
}

function resourceSingularLabel(kind: ProjectMemberOffboardingResourceKind): string {
  switch (kind) {
    case 'trigger':
      return 'trigger';
    case 'task_tree':
      return 'running task';
    case 'node':
      return 'node';
    case 'deployment_environment':
      return 'deployment';
    case 'project_attachment':
      return 'project credential attachment';
    default:
      return 'resource';
  }
}

function offboardingActionLabel(
  action: ProjectMemberOffboardingAction,
  resource: ProjectMemberOffboardingResourcePreview
): string {
  switch (action) {
    case 'break_and_flag':
      if (resource.resourceKind === 'trigger') return 'Disable and flag';
      if (resource.resourceKind === 'task_tree') return 'Stop future work and flag';
      if (resource.resourceKind === 'node' || resource.resourceKind === 'deployment_environment') {
        return 'Mark blocked for replacement';
      }
      return 'Disable and flag';
    case 'reattach_to_project':
      return 'Use existing project credential';
    case 'defer_removal':
      return 'Defer removal';
    default:
      return action;
  }
}

function errorGuidance(err: unknown): string {
  if (!(err instanceof ApiClientError)) {
    return err instanceof Error ? err.message : 'Unable to complete offboarding.';
  }
  switch (err.code) {
    case 'stale_plan':
      return 'The project changed after this preview was created. Refresh the preview and review the resources again.';
    case 'expired_plan':
    case 'expired':
      return 'This offboarding preview expired. Refresh the preview and try again.';
    case 'unresolved_credential_attribution':
      return 'Some affected resources were not resolved by the selected actions. Refresh the preview and choose an action for every resource.';
    case 'last_owner_requires_transfer':
      return 'This member is the last owner. Transfer ownership before they leave or are removed.';
    default:
      return err.message;
  }
}

function resourceImpactCopy(
  resource: ProjectMemberOffboardingResourcePreview,
  memberName: string
): string {
  switch (resource.resourceKind) {
    case 'trigger':
      return `This trigger runs on ${memberName}'s personal key. Removing this member will disable the trigger unless you attach a project credential.`;
    case 'task_tree': {
      const status = detailString(resource.details, 'status');
      return status === 'running'
        ? `This running task is using ${memberName}'s personal key. Stop it or replace it with a project credential before removal.`
        : `This task is queued on ${memberName}'s personal key. Removing this member will stop future work unless you attach a project credential.`;
    }
    case 'node':
      return `This node is still running on ${memberName}'s cloud credential. Stop or replace it with a project credential before removal.`;
    case 'deployment_environment':
      return `This deployment node is still running on the departing member's cloud credential. Stop or replace it before removal.`;
    case 'project_attachment':
      return `This project attachment depends on ${memberName}'s credential. Replace it with a project credential owned by a remaining member before relying on it.`;
    default:
      return `This resource uses ${memberName}'s personal key. Choose how to handle it before removal.`;
  }
}

type OffboardingMode = 'remove' | 'leave';

function GithubStatusBadge({ status }: { status: ProjectInviteGithubAccessStatus }) {
  const meta = GITHUB_STATUS_META[status] ?? GITHUB_STATUS_META.unchecked;
  return (
    <span
      className={`inline-flex max-w-full text-[0.6875rem] px-1.5 py-px rounded-sm shrink-0 ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function MemberRow({
  member,
  isCurrentUser,
  canManage,
  isOwner,
  disabled,
  onTransfer,
  onRemove,
  onLeave,
}: {
  canManage: boolean;
  disabled: boolean;
  isCurrentUser: boolean;
  isOwner: boolean;
  member: ProjectMemberResponse;
  onLeave: (member: ProjectMemberResponse) => void;
  onRemove: (member: ProjectMemberResponse) => void;
  onTransfer: (member: ProjectMemberResponse) => void;
}) {
  const active = member.status === 'active';
  const canTransfer = isOwner && active && member.role === 'admin';
  const canRemove = canManage && active && member.role !== 'owner' && !isCurrentUser;
  const canLeave = isCurrentUser && active && member.role !== 'owner';

  return (
    <div className="grid gap-2 py-2 border-b border-border-subtle last:border-b-0 min-w-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="text-[0.8125rem] font-medium text-fg-primary truncate">
          {userLabel(member)}
        </div>
        <div className="text-[0.75rem] text-fg-muted truncate">
          {member.user?.email ?? member.userId}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <span className="text-[0.6875rem] px-1.5 py-px rounded-sm bg-inset text-fg-muted">
          {member.role}
        </span>
        {member.status !== 'active' && (
          <span className="text-[0.6875rem] px-1.5 py-px rounded-sm bg-inset text-fg-muted">
            {member.status}
          </span>
        )}
        {canTransfer && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onTransfer(member)}
          >
            <Crown size={14} />
            Transfer ownership
          </Button>
        )}
        {canRemove && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onRemove(member)}
          >
            <Trash2 size={14} />
            Remove member
          </Button>
        )}
        {canLeave && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onLeave(member)}
          >
            <DoorOpen size={14} />
            Leave project
          </Button>
        )}
      </div>
    </div>
  );
}

function OffboardingModal({
  applying,
  error,
  loading,
  member,
  mode,
  onApply,
  onClose,
  onRefresh,
  preview,
}: {
  applying: boolean;
  error: string | null;
  loading: boolean;
  member: ProjectMemberResponse;
  mode: OffboardingMode;
  onApply: (actions: Record<string, ProjectMemberOffboardingAction>) => void;
  onClose: () => void;
  onRefresh: () => void;
  preview: ProjectMemberOffboardingPreviewResponse | null;
}) {
  const memberName = userLabel(member);
  const [selectedActions, setSelectedActions] = useState<Record<string, ProjectMemberOffboardingAction>>({});

  useEffect(() => {
    if (!preview) {
      setSelectedActions({});
      return;
    }
    setSelectedActions(
      Object.fromEntries(
        preview.resources.map((resource) => [
          offboardingResourceKey(resource),
          defaultOffboardingAction(resource),
        ])
      )
    );
  }, [preview]);

  const grouped = useMemo(() => {
    const result = new Map<ProjectMemberOffboardingResourceKind, ProjectMemberOffboardingResourcePreview[]>();
    for (const resource of preview?.resources ?? []) {
      const items = result.get(resource.resourceKind) ?? [];
      items.push(resource);
      result.set(resource.resourceKind, items);
    }
    return Array.from(result.entries());
  }, [preview?.resources]);

  const title = mode === 'leave' ? 'Leave project' : 'Remove member';
  const confirmLabel = mode === 'leave' ? 'Leave project' : 'Remove member';
  const resourceCount = preview?.resources.length ?? 0;

  return createPortal(
    <div className="fixed inset-0 z-[var(--sam-z-dialog-backdrop)] overflow-y-auto">
      <button
        type="button"
        aria-label="Close offboarding"
        className="fixed inset-0 glass-backdrop-dim border-0 cursor-default"
        onClick={applying ? undefined : onClose}
      />
      <div className="flex min-h-full items-start justify-center p-3 sm:items-center sm:p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="offboarding-title"
          className="relative glass-modal glass-panel-container w-full max-w-3xl max-h-[calc(100dvh-1.5rem)] overflow-hidden rounded-lg border border-border-default shadow-xl flex flex-col"
        >
          <div className="flex items-start gap-3 border-b border-border-default px-4 py-3">
            <ShieldCheck size={18} className="mt-0.5 text-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 id="offboarding-title" className="m-0 text-base font-semibold text-fg-primary">
                {title}: {memberName}
              </h2>
              <p className="m-0 mt-1 text-xs text-fg-muted">
                Review resources using this member&apos;s personal credentials before membership changes.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              disabled={applying}
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-border-default bg-transparent text-fg-muted hover:text-fg-primary disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loading ? (
              <div className="flex items-center gap-2 rounded-md border border-border-default bg-inset p-3 text-sm text-fg-muted">
                <Spinner size="sm" />
                Loading offboarding preview...
              </div>
            ) : (
              <div className="grid gap-3">
                {error && (
                  <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-tint p-3 text-xs text-warning-fg">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-semibold text-fg-primary">Preview needs refresh</div>
                      <p className="m-0 mt-1 break-words">{error}</p>
                    </div>
                  </div>
                )}

                {preview && (
                  <>
                    <div className="grid gap-2 rounded-md border border-border-default bg-inset p-3 text-xs sm:grid-cols-3">
                      <div>
                        <div className="font-semibold text-fg-primary">{preview.summary.breakAndFlag}</div>
                        <div className="text-fg-muted">will be disabled or flagged</div>
                      </div>
                      <div>
                        <div className="font-semibold text-fg-primary">{preview.summary.reattachAvailable}</div>
                        <div className="text-fg-muted">can use existing project credentials</div>
                      </div>
                      <div>
                        <div className="font-semibold text-fg-primary">{preview.summary.blockingTeardown}</div>
                        <div className="text-fg-muted">need stop or replacement</div>
                      </div>
                    </div>

                    {resourceCount === 0 ? (
                      <div className="rounded-md border border-border-default bg-inset p-3 text-sm text-fg-muted">
                        No live personal-backed resources were found. This member can be removed cleanly.
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        {grouped.map(([kind, resources]) => (
                          <section key={kind} className="grid gap-2">
                            <h3 className="m-0 text-sm font-semibold text-fg-primary">
                              {resourceKindLabel(kind)}
                            </h3>
                            <div className="grid gap-2">
                              {resources.map((resource) => {
                                const key = offboardingResourceKey(resource);
                                const selected = selectedActions[key] ?? defaultOffboardingAction(resource);
                                const projectCoverage = hasRemainingProjectCoverage(resource);
                                return (
                                  <div
                                    key={key}
                                    className="rounded-md border border-border-default bg-inset p-3"
                                  >
                                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)] md:items-start">
                                      <div className="min-w-0">
                                        <div className="text-sm font-medium text-fg-primary break-words">
                                          {resource.title}
                                        </div>
                                      </div>
                                      <label className="grid gap-1 text-xs text-fg-muted">
                                        Action
                                        <select
                                          value={selected}
                                          onChange={(event) =>
                                            setSelectedActions((current) => ({
                                              ...current,
                                              [key]: event.target.value as ProjectMemberOffboardingAction,
                                            }))
                                          }
                                          className="min-h-9 rounded-sm border border-border-default bg-surface px-2 py-1 text-xs text-fg-primary"
                                        >
                                          {resource.availableActions.map((action) => (
                                            <option key={action} value={action}>
                                              {offboardingActionLabel(action, resource)}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    </div>
                                    <div className="mt-2 text-xs text-fg-muted break-words">
                                      {resource.subtitle ?? resourceSingularLabel(resource.resourceKind)}
                                    </div>
                                    <p className="m-0 mt-2 text-xs text-fg-muted break-words">
                                      {resourceImpactCopy(resource, memberName)}
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-1.5 text-[0.6875rem]">
                                      {resource.blocksRemoval && (
                                        <span className="rounded-sm bg-warning-tint px-1.5 py-px text-warning-fg">
                                          blocks immediate removal
                                        </span>
                                      )}
                                      {projectCoverage ? (
                                        <span className="rounded-sm bg-success-tint px-1.5 py-px text-success">
                                          project credential available
                                        </span>
                                      ) : (
                                        <span className="rounded-sm bg-inset px-1.5 py-px text-fg-muted">
                                          no active project credential covers this consumer
                                        </span>
                                      )}
                                      {resource.href && (
                                        <a
                                          href={resource.href}
                                          className="rounded-sm bg-surface px-1.5 py-px text-accent underline-offset-2 hover:underline"
                                        >
                                          Open fix surface
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-default p-4">
            <Button variant="secondary" disabled={applying} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={loading || applying} onClick={onRefresh}>
              <RefreshCcw size={14} />
              Refresh preview
            </Button>
            <Button
              variant="danger"
              loading={applying}
              disabled={loading || applying || !preview}
              onClick={() => onApply(selectedActions)}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function CredentialTransitionWarning({
  health,
}: {
  health: ProjectCredentialAttributionHealthSummary;
}) {
  const resources = health.resources.filter((resource) =>
    resource.checks.some((check) => check.source === 'personal')
  );
  if (resources.length === 0) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-tint px-3 py-2 text-xs text-warning-fg">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-semibold text-fg-primary">Credential checklist before sharing</div>
        <p className="m-0 mt-1">
          {health.counts.personalResources} shared resource{health.counts.personalResources === 1 ? '' : 's'} still run on personal keys.
          Invite and approval can continue.
        </p>
        <div className="mt-2 grid gap-1">
          {resources.slice(0, 3).map((resource) => (
            <div key={resource.id} className="truncate">
              {resource.title}: {resource.checks.filter((check) => check.source === 'personal').map((check) => check.consumerKind).join(', ')}
            </div>
          ))}
          {resources.length > 3 && (
            <div>{resources.length - 3} more in credential health.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestRow({
  request,
  disabled,
  onApprove,
  onDeny,
}: {
  disabled: boolean;
  onApprove: (request: ProjectAccessRequestResponse) => void;
  onDeny: (request: ProjectAccessRequestResponse) => void;
  request: ProjectAccessRequestResponse;
}) {
  return (
    <div className="grid gap-2 py-2 border-b border-border-subtle last:border-b-0 min-w-0">
      <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-2">
        <div className="min-w-0">
          <div className="text-[0.8125rem] font-medium text-fg-primary truncate">
            {requestUserLabel(request)}
          </div>
          <div className="text-[0.75rem] text-fg-muted truncate">
            {request.requester?.email ?? request.requesterUserId}
          </div>
        </div>
        <GithubStatusBadge status={request.githubAccessStatus} />
      </div>
      {request.githubAccessMessage && (
        <p className="m-0 text-[0.75rem] text-fg-muted break-words">
          {request.githubAccessMessage}
        </p>
      )}
      <div className="flex flex-wrap gap-2 justify-end">
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => onDeny(request)}
        >
          <X size={14} />
          Deny
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => onApprove(request)}>
          <Check size={14} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export function ProjectMembersSection({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<ProjectMembersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdInviteLink, setCreatedInviteLink] = useState<ProjectInviteLinkResponse | null>(null);
  const [credentialHealth, setCredentialHealth] =
    useState<ProjectCredentialAttributionHealthSummary | null>(null);
  const [transferTarget, setTransferTarget] = useState<ProjectMemberResponse | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [offboardingTarget, setOffboardingTarget] = useState<{
    member: ProjectMemberResponse;
    mode: OffboardingMode;
  } | null>(null);
  const [offboardingPreview, setOffboardingPreview] =
    useState<ProjectMemberOffboardingPreviewResponse | null>(null);
  const [offboardingLoading, setOffboardingLoading] = useState(false);
  const [offboardingApplying, setOffboardingApplying] = useState(false);
  const [offboardingError, setOffboardingError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [members, health] = await Promise.all([
        getProjectMembers(projectId),
        getProjectCredentialAttributionHealth(projectId).catch(() => null),
      ]);
      setData(members);
      setCredentialHealth(health);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentMember = useMemo(
    () => data?.members.find((member) => member.userId === user?.id && member.status === 'active'),
    [data?.members, user?.id]
  );
  const canManage = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  const isOwner = currentMember?.role === 'owner';
  const pendingRequests = data?.accessRequests.filter((request) => request.status === 'pending') ?? [];
  const activeInvite =
    createdInviteLink ?? data?.inviteLinks.find((link) => link.status === 'active') ?? null;
  const multiplayerTransitionActive =
    (data?.members.filter((member) => member.status === 'active').length ?? 0) > 1 ||
    Boolean(activeInvite) ||
    pendingRequests.length > 0;
  const inviteUrl =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/projects/invite/${createdToken ?? ''}`;

  const handleCreate = async () => {
    try {
      setCreating(true);
      const link = await createProjectInviteLink(projectId);
      setCreatedToken(link.token);
      setCreatedInviteLink(link);
      setData((current) =>
        current
          ? {
              ...current,
              inviteLinks: [link, ...current.inviteLinks],
            }
          : current
      );
      toast.success('Invite link created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create invite link');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdToken) {
      toast.error('Create a fresh link to copy it');
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success('Invite link copied');
    } catch {
      toast.error('Failed to copy invite link');
    }
  };

  const handleRevoke = async (link: ProjectInviteLinkResponse) => {
    try {
      setRevokingId(link.id);
      const revoked = await revokeProjectInviteLink(projectId, link.id);
      setData((current) =>
        current
          ? {
              ...current,
              inviteLinks: current.inviteLinks.map((item) =>
                item.id === revoked.id ? revoked : item
              ),
            }
          : current
      );
      if (activeInvite?.id === link.id) {
        setCreatedToken(null);
        setCreatedInviteLink(null);
      }
      toast.success('Invite link revoked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke invite link');
    } finally {
      setRevokingId(null);
    }
  };

  const handleApprove = async (request: ProjectAccessRequestResponse) => {
    try {
      setDecidingId(request.id);
      const updated = await approveProjectAccessRequest(projectId, request.id);
      setData((current) =>
        current
          ? {
              ...current,
              accessRequests: current.accessRequests.map((item) =>
                item.id === updated.id ? updated : item
              ),
            }
          : current
      );
      await load();
      toast.success('Access approved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve request');
    } finally {
      setDecidingId(null);
    }
  };

  const handleDeny = async (request: ProjectAccessRequestResponse) => {
    try {
      setDecidingId(request.id);
      const updated = await denyProjectAccessRequest(projectId, request.id);
      setData((current) =>
        current
          ? {
              ...current,
              accessRequests: current.accessRequests.map((item) =>
                item.id === updated.id ? updated : item
              ),
            }
          : current
      );
      toast.success('Access denied');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to deny request');
    } finally {
      setDecidingId(null);
    }
  };

  const loadOffboardingPreview = useCallback(
    async (member: ProjectMemberResponse, mode: OffboardingMode) => {
      setOffboardingTarget({ member, mode });
      setOffboardingPreview(null);
      setOffboardingError(null);
      setOffboardingLoading(true);
      try {
        const preview = await previewProjectMemberOffboarding(projectId, member.userId);
        setOffboardingPreview(preview);
      } catch (err) {
        setOffboardingError(errorGuidance(err));
      } finally {
        setOffboardingLoading(false);
      }
    },
    [projectId]
  );

  const handleTransferOwnership = async () => {
    if (!transferTarget) return;
    try {
      setTransferring(true);
      await transferProjectOwnership(projectId, {
        toUserId: transferTarget.userId,
        oldOwnerRole: 'admin',
      });
      setTransferTarget(null);
      await load();
      toast.success(`${userLabel(transferTarget)} is now the project owner`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to transfer ownership');
    } finally {
      setTransferring(false);
    }
  };

  const handleApplyOffboarding = async (
    selectedActions: Record<string, ProjectMemberOffboardingAction>
  ) => {
    if (!offboardingTarget || !offboardingPreview) return;
    try {
      setOffboardingApplying(true);
      setOffboardingError(null);
      await applyProjectMemberOffboarding(projectId, offboardingTarget.member.userId, {
        planId: offboardingPreview.offboardingPlanId,
        finalMemberStatus: 'removed',
        actions: offboardingPreview.resources.map((resource) => ({
          resourceKind: resource.resourceKind,
          resourceId: resource.resourceId,
          action: selectedActions[offboardingResourceKey(resource)] ?? defaultOffboardingAction(resource),
        })),
      });
      const successMessage =
        offboardingTarget.mode === 'leave' ? 'You left the project' : 'Member removed';
      setOffboardingTarget(null);
      setOffboardingPreview(null);
      await load();
      toast.success(successMessage);
    } catch (err) {
      setOffboardingError(errorGuidance(err));
    } finally {
      setOffboardingApplying(false);
    }
  };

  const closeOffboarding = () => {
    if (offboardingApplying) return;
    setOffboardingTarget(null);
    setOffboardingPreview(null);
    setOffboardingError(null);
  };

  return (
    <section className="glass-surface rounded-lg p-4 grid gap-4 min-w-0 overflow-hidden">
      <div className="grid gap-3 sm:flex sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Members</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted break-words">
            Invite links create access requests. Owners and admins approve membership.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={loading}
          className="justify-self-start"
          onClick={() => void load()}
        >
          <RefreshCcw size={14} />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Loading members&hellip;</span>
        </div>
      ) : (
        <div className="grid gap-4 min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <div className="grid gap-3 min-w-0">
            {credentialHealth && multiplayerTransitionActive && (
              <CredentialTransitionWarning health={credentialHealth} />
            )}

            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="sam-type-card-title m-0 text-fg-primary">Current Members</h3>
                <span className="text-[0.75rem] text-fg-muted">{data?.members.length ?? 0}</span>
              </div>
              <div className="mt-2 rounded-md border border-border-default bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_60%,transparent)] px-3 min-w-0">
                {data?.members.length ? (
                  data.members.map((member) => (
                    <MemberRow
                      key={member.userId}
                      member={member}
                      isCurrentUser={member.userId === user?.id}
                      canManage={Boolean(canManage)}
                      isOwner={Boolean(isOwner)}
                      disabled={offboardingLoading || offboardingApplying || transferring}
                      onTransfer={setTransferTarget}
                      onRemove={(value) => void loadOffboardingPreview(value, 'remove')}
                      onLeave={(value) => void loadOffboardingPreview(value, 'leave')}
                    />
                  ))
                ) : (
                  <div className="py-3 text-xs text-fg-muted">No members found.</div>
                )}
              </div>
            </div>

            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="sam-type-card-title m-0 text-fg-primary">Pending Requests</h3>
                <span className="text-[0.75rem] text-fg-muted">{pendingRequests.length}</span>
              </div>
              <div className="mt-2 rounded-md border border-border-default bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_60%,transparent)] px-3 min-w-0">
                {pendingRequests.length ? (
                  pendingRequests.map((request) => (
                    <RequestRow
                      key={request.id}
                      request={request}
                      disabled={!canManage || decidingId === request.id}
                      onApprove={(value) => void handleApprove(value)}
                      onDeny={(value) => void handleDeny(value)}
                    />
                  ))
                ) : (
                  <div className="py-3 text-xs text-fg-muted">No pending requests.</div>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border-default bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_60%,transparent)] p-3 grid gap-3 content-start min-w-0">
            <div className="flex items-center gap-2">
              <UserPlus size={16} className="text-fg-muted" />
              <h3 className="sam-type-card-title m-0 text-fg-primary">Invite Link</h3>
            </div>

            {activeInvite ? (
              <div className="grid gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <LinkIcon size={14} className="text-fg-muted shrink-0" />
                  <div className="min-w-0 text-[0.8125rem] text-fg-primary">
                    <div className="truncate">Expires {formatDate(activeInvite.expiresAt)}</div>
                    <div className="text-[0.75rem] text-fg-muted">
                      Used {activeInvite.useCount} times
                    </div>
                  </div>
                </div>

                {createdToken && (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-center">
                    <input
                      readOnly
                      aria-label="Invite link"
                      value={inviteUrl}
                      className="min-w-0 py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                    />
                    <Button size="sm" variant="secondary" onClick={() => void handleCopy()}>
                      <Copy size={14} />
                      Copy
                    </Button>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" loading={creating} disabled={creating} onClick={() => void handleCreate()}>
                    <UserPlus size={14} />
                    New Link
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={revokingId === activeInvite.id}
                    disabled={revokingId === activeInvite.id}
                    onClick={() => void handleRevoke(activeInvite)}
                  >
                    <X size={14} />
                    Revoke
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
                <p className="m-0 text-xs text-fg-muted">No active invite link.</p>
                <div>
                  <Button size="sm" loading={creating} disabled={creating} onClick={() => void handleCreate()}>
                    <UserPlus size={14} />
                    Create Link
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={Boolean(transferTarget)}
        onClose={() => {
          if (!transferring) setTransferTarget(null);
        }}
        onConfirm={() => void handleTransferOwnership()}
        title="Transfer ownership"
        variant="warning"
        loading={transferring}
        confirmLabel="Transfer ownership"
        message={
          transferTarget ? (
            <div className="grid gap-2">
              <p className="m-0">
                {userLabel(transferTarget)} will become the project owner. Your account becomes an
                admin and keeps admin-level controls, but ownership-only actions move to the new owner.
              </p>
              <p className="m-0">
                Existing personal credentials stay with their owners. This action does not copy or
                move any secret.
              </p>
            </div>
          ) : null
        }
      />
      {offboardingTarget && (
        <OffboardingModal
          member={offboardingTarget.member}
          mode={offboardingTarget.mode}
          preview={offboardingPreview}
          loading={offboardingLoading}
          applying={offboardingApplying}
          error={offboardingError}
          onClose={closeOffboarding}
          onRefresh={() =>
            void loadOffboardingPreview(offboardingTarget.member, offboardingTarget.mode)
          }
          onApply={(actions) => void handleApplyOffboarding(actions)}
        />
      )}
    </section>
  );
}
