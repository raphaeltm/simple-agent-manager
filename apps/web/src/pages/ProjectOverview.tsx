import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { ProjectForm, type ProjectFormValues } from '../components/project/ProjectForm';
import { WorkspaceCard } from '../components/WorkspaceCard';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import {
  createWorkspace,
  deleteProject,
  listWorkspaces,
  stopWorkspace,
  restartWorkspace,
  deleteWorkspace,
  updateProject,
} from '../lib/api';
import { useToast } from '../hooks/useToast';
import { useProjectContext } from './ProjectContext';

export function ProjectOverview() {
  const navigate = useNavigate();
  const toast = useToast();
  const { project, projectId, installations, reload } = useProjectContext();

  const [showProjectEdit, setShowProjectEdit] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [launchingWorkspace, setLaunchingWorkspace] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);

  const fetchWorkspaces = useCallback(async () => {
    if (!projectId) return;
    try {
      setWorkspacesLoading(true);
      const data = await listWorkspaces(undefined, undefined, projectId);
      setWorkspaces(data);
    } catch {
      // Silently fail — workspace list is supplementary info
    } finally {
      setWorkspacesLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleStopWorkspace = async (id: string) => {
    try {
      await stopWorkspace(id);
      toast.success('Workspace stopping');
      await fetchWorkspaces();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to stop workspace');
    }
  };

  const handleRestartWorkspace = async (id: string) => {
    try {
      await restartWorkspace(id);
      toast.success('Workspace restarting');
      await fetchWorkspaces();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restart workspace');
    }
  };

  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
      toast.success('Workspace deleted');
      await fetchWorkspaces();
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete workspace');
    }
  };

  const handleProjectUpdate = async (values: ProjectFormValues) => {
    try {
      setSavingProject(true);
      await updateProject(projectId, {
        name: values.name,
        description: values.description || undefined,
        defaultBranch: values.defaultBranch,
      });
      toast.success('Project updated');
      setShowProjectEdit(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update project');
    } finally {
      setSavingProject(false);
    }
  };

  const handleLaunchWorkspace = async () => {
    if (!project) return;
    try {
      setLaunchingWorkspace(true);
      const workspace = await createWorkspace({
        name: `${project.name} Workspace`,
        projectId: project.id,
        vmSize: project.defaultVmSize ?? undefined,
      });
      toast.success('Workspace launch started');
      await fetchWorkspaces();
      navigate(`/workspaces/${workspace.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to launch workspace');
    } finally {
      setLaunchingWorkspace(false);
    }
  };

  if (!project) return null;

  return (
    <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
        <Button
          onClick={handleLaunchWorkspace}
          loading={launchingWorkspace}
          disabled={launchingWorkspace || project.status === 'detached'}
          title={project.status === 'detached' ? 'Cannot launch workspace for a detached project' : undefined}
        >
          Launch Workspace
        </Button>
        <Button variant="secondary" onClick={() => setShowProjectEdit((v) => !v)}>
          {showProjectEdit ? 'Close edit' : 'Edit project'}
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (!window.confirm(`Delete project "${project.name}"?`)) return;
            try {
              await deleteProject(project.id);
              toast.success('Project deleted');
              navigate('/projects');
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Failed to delete project');
            }
          }}
        >
          Delete project
        </Button>
      </div>

      {/* Detached warning */}
      {project.status === 'detached' && (
        <Alert variant="warning">
          This project&apos;s GitHub repository has been deleted. Workspace creation is disabled.
          You can still view existing sessions, tasks, and activity.
        </Alert>
      )}

      {/* Summary stats */}
      <section
        style={{
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
          background: 'var(--sam-color-bg-surface)',
          padding: 'var(--sam-space-3)',
          display: 'grid',
          gap: 'var(--sam-space-2)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem' }}>
          <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>Tasks:</span>
          {(Object.entries(project.summary.taskCountsByStatus) as [string, number][])
            .filter(([, count]) => count > 0)
            .map(([status, count]) => (
              <StatusBadge
                key={status}
                status={status}
                label={`${status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} (${count})`}
              />
            ))}
          {Object.values(project.summary.taskCountsByStatus).every((c) => c === 0) && (
            <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>none</span>
          )}
        </div>
      </section>

      {/* Workspaces section */}
      <section>
        <h3 style={{ margin: '0 0 var(--sam-space-3)', fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>
          Workspaces ({workspaces.length})
        </h3>
        {workspacesLoading && workspaces.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-4)' }}>
            <Spinner />
          </div>
        ) : workspaces.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-secondary-size)' }}>
            No workspaces yet. Launch one to get started.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
            {workspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                workspace={ws}
                onStop={handleStopWorkspace}
                onRestart={handleRestartWorkspace}
                onDelete={handleDeleteWorkspace}
              />
            ))}
          </div>
        )}
      </section>

      {/* Edit form */}
      {showProjectEdit && (
        <section
          style={{
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            background: 'var(--sam-color-bg-surface)',
            padding: 'var(--sam-space-3)',
          }}
        >
          <ProjectForm
            mode="edit"
            installations={installations}
            initialValues={{
              name: project.name,
              description: project.description ?? '',
              installationId: project.installationId,
              repository: project.repository,
              defaultBranch: project.defaultBranch,
            }}
            submitting={savingProject}
            onSubmit={handleProjectUpdate}
            onCancel={() => setShowProjectEdit(false)}
          />
        </section>
      )}
    </div>
  );
}
