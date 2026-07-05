import type { ProjectCredentialAttributionHealthSummary } from '@simple-agent-manager/shared';
import { AlertTriangle, CheckCircle2, KeyRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';

import { getProjectCredentialAttributionHealth } from '../lib/api';

interface CredentialHealthNavItemProps {
  projectId: string | undefined;
  compact?: boolean;
}

function userLabel(user: { name: string | null; email: string | null; id: string } | null): string {
  return user?.name || user?.email || user?.id || 'Project member';
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function runtimeResourceKind(resource: ProjectCredentialAttributionHealthSummary['resources'][number]): string {
  return String(resource.kind);
}

function resourceGroupLabel(kind: string): string {
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

function resourceByline(
  resource: ProjectCredentialAttributionHealthSummary['resources'][number]
): string {
  const kind = runtimeResourceKind(resource);
  const creator = resource.createdBy ? ` by ${userLabel(resource.createdBy)}` : '';
  switch (kind) {
    case 'trigger':
      return `Trigger${creator}`;
    case 'task_tree':
      return `Running task${creator}`;
    case 'node':
      return `Node${creator}`;
    case 'deployment_environment':
      return `Deployment${creator}`;
    case 'project_attachment':
      return `Project credential attachment${creator}`;
    default:
      return `Resource${creator}`;
  }
}

function needsResourceAttention(
  resource: ProjectCredentialAttributionHealthSummary['resources'][number]
): boolean {
  return resource.checks.some((check) => check.source === 'personal' || check.source === 'unknown');
}

function countLabel(summary: ProjectCredentialAttributionHealthSummary): string {
  const resourcesNeedingAttention = summary.resources.filter(needsResourceAttention).length;
  if (resourcesNeedingAttention > 0 || summary.counts.personalCredentials > 0) {
    return `${pluralize(Math.max(resourcesNeedingAttention, summary.counts.personalResources), 'resource')} / ${pluralize(summary.counts.personalCredentials, 'key', 'keys')}`;
  }
  if (summary.counts.projectCoveredCredentials > 0) {
    return `${summary.counts.projectCoveredCredentials} covered`;
  }
  return 'No shared keys';
}

function CredentialHealthModal({
  summary,
  onClose,
}: {
  summary: ProjectCredentialAttributionHealthSummary;
  onClose: () => void;
}) {
  const groupedResources = Array.from(
    summary.resources.reduce((groups, resource) => {
      const kind = runtimeResourceKind(resource);
      const resources = groups.get(kind) ?? [];
      resources.push(resource);
      groups.set(kind, resources);
      return groups;
    }, new Map<string, ProjectCredentialAttributionHealthSummary['resources']>())
  );
  const resourcesNeedingAttention = summary.resources.filter(needsResourceAttention).length;

  return createPortal(
    <div className="fixed inset-0 z-[var(--sam-z-dialog-backdrop)] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close credential health"
        className="absolute inset-0 bg-black/45 border-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-health-title"
        className="relative glass-modal w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-lg border border-border-default shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-border-default px-4 py-3">
          <KeyRound size={18} className="text-accent shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 id="credential-health-title" className="m-0 text-sm font-semibold text-fg-primary">
              Credential Attribution
            </h2>
            <p className="m-0 mt-0.5 text-xs text-fg-muted">
              {resourcesNeedingAttention > 0 || summary.counts.personalCredentials > 0
                ? `${resourcesNeedingAttention} credential-backed resources need review`
                : 'Shared resources are covered by project credentials'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-sm border border-border-default bg-transparent text-fg-muted hover:text-fg-primary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 border-b border-border-default px-4 py-3 text-xs">
          <div>
            <div className="font-semibold text-fg-primary">{resourcesNeedingAttention}</div>
            <div className="text-fg-muted">needs review</div>
          </div>
          <div>
            <div className="font-semibold text-fg-primary">{summary.counts.personalCredentials}</div>
            <div className="text-fg-muted">personal keys</div>
          </div>
          <div>
            <div className="font-semibold text-fg-primary">{summary.counts.projectCoveredCredentials}</div>
            <div className="text-fg-muted">project covered</div>
          </div>
        </div>

        <div className="max-h-[58vh] overflow-y-auto px-4 py-3">
          {summary.resources.length === 0 ? (
            <div className="rounded-md border border-border-default bg-inset p-3 text-sm text-fg-muted">
              No credential-backed shared resources found.
            </div>
          ) : (
            <div className="grid gap-3">
              {groupedResources.map(([kind, resources]) => (
                <section key={kind} className="grid gap-2">
                  <h3 className="m-0 text-xs font-semibold uppercase text-fg-muted">
                    {resourceGroupLabel(kind)}
                  </h3>
                  <div className="grid gap-2">
                    {resources.map((resource) => (
                      <div key={resource.id} className="rounded-md border border-border-default bg-inset p-3">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-fg-primary break-words">{resource.title}</div>
                            <div className="text-xs text-fg-muted break-words">
                              {resourceByline(resource)}
                            </div>
                          </div>
                          <Link
                            to={resource.href}
                            onClick={onClose}
                            className="shrink-0 text-xs font-medium text-accent underline-offset-2 hover:underline"
                          >
                            Open
                          </Link>
                        </div>
                        <div className="mt-3 grid gap-2">
                          {resource.checks.map((check) => (
                            <div
                              key={`${resource.id}-${check.consumerKind}-${check.consumerTarget}`}
                              className="flex items-start gap-2 rounded-sm bg-surface px-2 py-2 text-xs"
                            >
                              {check.source === 'project' ? (
                                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                              ) : (
                                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="font-medium text-fg-primary">{check.label}</div>
                                <div className="text-fg-muted break-words">
                                  {check.source === 'project'
                                    ? `Project credential: ${check.projectCredential?.configurationName ?? 'configured'}`
                                    : check.warning}
                                </div>
                              </div>
                              {check.source !== 'project' && (
                                <Link
                                  to={check.fixHref}
                                  onClick={onClose}
                                  className="shrink-0 text-accent underline-offset-2 hover:underline"
                                >
                                  Fix
                                </Link>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function CredentialHealthNavItem({ projectId, compact = false }: CredentialHealthNavItemProps) {
  const [summary, setSummary] = useState<ProjectCredentialAttributionHealthSummary | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setSummary(null);
      return;
    }
    getProjectCredentialAttributionHealth(projectId)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId || !summary || summary.counts.resources === 0) return null;

  const needsAttention = summary.counts.personalCredentials > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open credential attribution health"
        className={`flex w-full items-center gap-2 rounded-sm border bg-transparent text-left transition-colors ${
          compact ? 'min-h-11 px-5 py-2.5 text-sm' : 'px-3 py-2 text-xs'
        } ${
          needsAttention
            ? 'border-warning/60 text-warning hover:bg-warning/10'
            : 'border-border-default text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
        }`}
      >
        {needsAttention ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
        <span className="min-w-0 flex-1 truncate">Credentials</span>
        <span className="max-w-[8.5rem] truncate rounded-full bg-surface px-2 py-0.5 text-[0.6875rem] font-semibold text-fg-primary">
          {countLabel(summary)}
        </span>
      </button>
      {open && <CredentialHealthModal summary={summary} onClose={() => setOpen(false)} />}
    </>
  );
}
