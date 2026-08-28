import type { ProjectSummary } from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  Secondary,
  Spinner,
} from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { Radio, Search, ShieldAlert } from 'lucide-react';
import type { CSSProperties, FormEvent } from 'react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { ProjectEventInspector } from '../components/admin/ProjectEventInspector';
import { useQueryScope } from '../hooks/useQueryScope';
import { PROJECT_LIST_LIMIT } from '../lib/project-query-config';
import {
  adminProjectEventInspectorQueryOptions,
  projectListQueryOptions,
} from '../lib/query-options';

const INSPECTOR_LIMIT = DEFAULT_PROJECT_EVENT_LIMITS.recentStatusLimit;
const PROJECT_BUTTON_TEXT_STYLE: CSSProperties = {
  display: '-webkit-box',
  overflow: 'hidden',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function projectButtonLabel(project: ProjectSummary): string {
  const repository = project.repository || 'no repository';
  return `${project.name} · ${repository}`;
}

export function AdminProjectEvents() {
  const queryScope = useQueryScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProjectId = searchParams.get('projectId')?.trim() ?? '';

  const projectsQuery = useQuery({
    ...projectListQueryOptions(queryScope, PROJECT_LIST_LIMIT),
    enabled: Boolean(queryScope),
  });

  const inspectorQuery = useQuery({
    ...adminProjectEventInspectorQueryOptions(queryScope, selectedProjectId, INSPECTOR_LIMIT),
    enabled: Boolean(queryScope && selectedProjectId),
    refetchOnWindowFocus: false,
  });

  const selectedProject = useMemo(
    () => projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null,
    [projectsQuery.data, selectedProjectId]
  );

  const setProjectId = (projectId: string) => {
    const next = new URLSearchParams(searchParams);
    if (projectId) {
      next.set('projectId', projectId);
    } else {
      next.delete('projectId');
    }
    setSearchParams(next);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const projectId = String(formData.get('projectId') ?? '').trim();
    setProjectId(projectId);
  };

  return (
    <div className="min-w-0 space-y-4" data-testid="admin-project-events-page">
      <Card className="min-w-0 p-4">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-tint px-2.5 py-1 text-xs font-semibold text-warning-fg">
                <ShieldAlert size={12} aria-hidden />
                Internal inspector
              </span>
              <span className="inline-flex rounded-full bg-surface-secondary px-2.5 py-1 text-xs font-semibold text-fg-muted">
                limit {INSPECTOR_LIMIT.toLocaleString()}
              </span>
            </div>
            <h1 className="m-0 text-xl font-semibold text-fg-primary">Project eventing status</h1>
            <p className="mt-2 max-w-3xl text-sm text-fg-muted">
              Superadmin-only read view for project event subscriptions and bounded recent
              ProjectData event status. It uses the B4 internal read surfaces and intentionally
              avoids public eventing controls or raw payload display.
            </p>
          </div>
          <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-xs text-warning-fg lg:max-w-sm">
            Normalized event titles, summaries, labels, and URLs are untrusted data. URLs are shown
            as escaped text, not links.
          </div>
        </div>
      </Card>

      <Card className="min-w-0 p-4">
        <form
          className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={handleSubmit}
        >
          <label className="min-w-0">
            <span className="mb-1 block text-sm font-medium text-fg-primary">Project ID</span>
            <Input
              key={selectedProjectId}
              name="projectId"
              defaultValue={selectedProjectId}
              autoComplete="off"
              placeholder="Paste a project ID to inspect"
              className="font-mono"
            />
          </label>
          <div className="flex items-end">
            <Button type="submit" className="w-full lg:w-auto">
              <Search size={16} aria-hidden />
              Inspect
            </Button>
          </div>
        </form>

        <div className="mt-4 min-w-0">
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-sm font-semibold text-fg-primary">Accessible projects</h2>
            {projectsQuery.isFetching && (
              <span className="inline-flex items-center gap-2 text-xs text-fg-muted">
                <Spinner size="sm" />
                Refreshing
              </span>
            )}
          </div>
          {projectsQuery.isError ? (
            <Alert variant="warning">
              {errorMessage(projectsQuery.error, 'Could not load accessible projects.')}
            </Alert>
          ) : projectsQuery.data && projectsQuery.data.length > 0 ? (
            <div className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {projectsQuery.data.map((project) => {
                const selected = project.id === selectedProjectId;
                return (
                  <button
                    key={project.id}
                    type="button"
                    aria-pressed={selected}
                    title={projectButtonLabel(project)}
                    onClick={() => setProjectId(project.id)}
                    className={`min-w-0 rounded-md border p-3 text-left transition-colors ${
                      selected
                        ? 'border-accent bg-accent/10 text-fg-primary'
                        : 'border-border-default bg-surface-secondary text-fg-primary hover:border-accent/60'
                    }`}
                  >
                    <span
                      className="block min-w-0 break-words text-sm font-medium"
                      style={PROJECT_BUTTON_TEXT_STYLE}
                    >
                      {project.name}
                    </span>
                    <span
                      className="mt-1 block min-w-0 break-all text-xs text-fg-muted"
                      style={PROJECT_BUTTON_TEXT_STYLE}
                    >
                      {project.repository}
                    </span>
                    <span
                      className="mt-1 block min-w-0 break-all font-mono text-xs text-fg-muted"
                      style={PROJECT_BUTTON_TEXT_STYLE}
                    >
                      {project.id}
                    </span>
                    <span className="mt-1 block text-xs text-fg-muted">
                      {project.status} · {project.activeSessionCount.toLocaleString()} active
                      sessions
                    </span>
                  </button>
                );
              })}
            </div>
          ) : projectsQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : (
            <Secondary>
              No accessible projects were returned. You can still paste a project ID.
            </Secondary>
          )}
        </div>
      </Card>

      {selectedProject && (
        <div className="rounded-md border border-border-default bg-surface-secondary p-3 text-sm text-fg-muted">
          Inspecting <span className="font-medium text-fg-primary">{selectedProject.name}</span>{' '}
          from the accessible project list. Superadmins can also inspect by pasting a project ID
          directly.
        </div>
      )}

      {inspectorQuery.isError && inspectorQuery.data && (
        <Alert variant="warning">
          Refresh failed; the last successful inspector response remains visible.{' '}
          {errorMessage(inspectorQuery.error, 'Could not refresh inspector data.')}
        </Alert>
      )}

      {!selectedProjectId ? (
        <EmptyState
          icon={<Radio className="h-full w-full" aria-hidden />}
          heading="Choose a project to inspect"
          description="Paste a project ID or select an accessible project to load subscriptions, recent normalized events, and delivery state."
        />
      ) : inspectorQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : inspectorQuery.isError ? (
        <Alert variant="error">
          {errorMessage(inspectorQuery.error, 'Could not load project eventing status.')}
        </Alert>
      ) : inspectorQuery.data ? (
        <ProjectEventInspector
          data={inspectorQuery.data}
          isRefreshing={inspectorQuery.isFetching}
          onRefresh={() => {
            void inspectorQuery.refetch();
          }}
        />
      ) : null}
    </div>
  );
}
