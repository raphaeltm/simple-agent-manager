import type {
  ProjectMemberOffboardingAction,
  ProjectMemberOffboardingPreviewResponse,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourcePreview,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { AlertTriangle, RefreshCcw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { ApiClientError } from '../../lib/api/client';

export type OffboardingMode = 'remove' | 'leave';

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

export function offboardingResourceKey(resource: ProjectMemberOffboardingResourcePreview): string {
  return `${resource.resourceKind}:${resource.resourceId}`;
}

export function defaultOffboardingAction(
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

export function offboardingErrorGuidance(err: unknown): string {
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

export function ProjectOffboardingModal({
  applying,
  error,
  loading,
  memberName,
  mode,
  onApply,
  onClose,
  onRefresh,
  preview,
}: {
  applying: boolean;
  error: string | null;
  loading: boolean;
  memberName: string;
  mode: OffboardingMode;
  onApply: (actions: Record<string, ProjectMemberOffboardingAction>) => void;
  onClose: () => void;
  onRefresh: () => void;
  preview: ProjectMemberOffboardingPreviewResponse | null;
}) {
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
