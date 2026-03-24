import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Spinner } from '@simple-agent-manager/ui';
import type { GcpProject } from '../lib/api';
import {
  getProjectDeploymentGcp,
  setupProjectDeploymentGcp,
  deleteProjectDeploymentGcp,
  listGcpProjectsForDeploy,
  type ProjectDeploymentGcpResponse,
} from '../lib/api';
import { useToast } from '../hooks/useToast';

const API_URL = import.meta.env.VITE_API_URL || '';

interface DeploymentSettingsProps {
  projectId: string;
}

export function DeploymentSettings({ projectId }: DeploymentSettingsProps) {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [deploymentCred, setDeploymentCred] = useState<ProjectDeploymentGcpResponse | null>(null);

  // Setup flow state
  const [phase, setPhase] = useState<'idle' | 'project-select' | 'setting-up' | 'done'>('idle');
  const [gcpProjects, setGcpProjects] = useState<GcpProject[]>([]);
  const [selectedGcpProject, setSelectedGcpProject] = useState<string>('');
  const [oauthHandle, setOauthHandle] = useState<string>('');
  const [settingUp, setSettingUp] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadDeploymentCred = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await getProjectDeploymentGcp(projectId);
      setDeploymentCred(resp);
    } catch {
      // Not configured
      setDeploymentCred({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadDeploymentCred();
  }, [loadDeploymentCred]);

  // Handle OAuth callback
  useEffect(() => {
    const handle = searchParams.get('gcp_deploy_setup');
    const error = searchParams.get('gcp_deploy_error');

    if (error) {
      toast.error(`GCP OAuth error: ${error}`);
      setSearchParams((prev) => {
        prev.delete('gcp_deploy_error');
        return prev;
      });
      return;
    }

    if (handle) {
      setOauthHandle(handle);
      // Remove from URL
      setSearchParams((prev) => {
        prev.delete('gcp_deploy_setup');
        return prev;
      });

      // Fetch GCP projects
      void listGcpProjectsForDeploy(projectId, handle)
        .then((resp) => {
          setGcpProjects(resp.projects);
          if (resp.projects.length > 0) {
            setSelectedGcpProject(resp.projects[0]!.projectId);
          }
          setPhase('project-select');
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to list GCP projects');
        });
    }
  }, [searchParams, setSearchParams, projectId, toast]);

  const handleConnectGcp = () => {
    // Redirect to OAuth
    window.location.href = `${API_URL}/api/projects/${projectId}/deployment/gcp/authorize`;
  };

  const handleSetup = async () => {
    if (!selectedGcpProject || !oauthHandle) return;
    setSettingUp(true);
    setPhase('setting-up');
    try {
      await setupProjectDeploymentGcp(projectId, {
        oauthHandle,
        gcpProjectId: selectedGcpProject,
      });
      toast.success('GCP deployment connected');
      setPhase('done');
      await loadDeploymentCred();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'GCP setup failed');
      setPhase('project-select');
    } finally {
      setSettingUp(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect GCP deployment credentials? Agents will no longer be able to deploy to GCP from this project.')) return;
    setDisconnecting(true);
    try {
      await deleteProjectDeploymentGcp(projectId);
      setDeploymentCred({ connected: false });
      setPhase('idle');
      toast.success('GCP deployment disconnected');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
        <h2 className="sam-type-section-heading m-0 text-fg-primary">
          Deploy to Cloud
        </h2>
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-sm text-fg-muted">Loading deployment config...</span>
        </div>
      </section>
    );
  }

  return (
    <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">
          Deploy to Cloud
        </h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Connect a GCP project for deployments via Defang. Agents use OIDC for short-lived credentials — no secrets stored.
        </p>
      </div>

      {/* Connected state */}
      {deploymentCred?.connected && phase !== 'project-select' && phase !== 'setting-up' ? (
        <div className="grid gap-3">
          <div className="border border-border-default rounded-sm p-3 bg-inset grid gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-sm font-medium text-fg-primary">GCP Connected</span>
            </div>
            <div className="grid gap-1 text-xs text-fg-muted">
              <div>
                <span className="font-medium text-fg-secondary">Project:</span>{' '}
                {deploymentCred.gcpProjectId}
              </div>
              <div>
                <span className="font-medium text-fg-secondary">Service Account:</span>{' '}
                <span className="break-all">{deploymentCred.serviceAccountEmail}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={disconnecting}
              disabled={disconnecting}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : null}

      {/* Disconnected state */}
      {!deploymentCred?.connected && phase === 'idle' ? (
        <div>
          <Button size="sm" onClick={handleConnectGcp}>
            Connect Google Cloud
          </Button>
        </div>
      ) : null}

      {/* Project selection */}
      {phase === 'project-select' ? (
        <div className="grid gap-3">
          <div>
            <label htmlFor="gcp-deploy-project" className="block text-xs font-medium text-fg-muted mb-1">
              Select GCP Project
            </label>
            <select
              id="gcp-deploy-project"
              value={selectedGcpProject}
              onChange={(e) => setSelectedGcpProject(e.target.value)}
              className="w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit]"
            >
              {gcpProjects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name} ({p.projectId})
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={settingUp}
              disabled={settingUp || !selectedGcpProject}
              onClick={() => void handleSetup()}
            >
              Set Up Deployment
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={settingUp}
              onClick={() => setPhase('idle')}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/* Setting up */}
      {phase === 'setting-up' ? (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-sm text-fg-muted">
            Creating WIF pool, OIDC provider, and service account...
          </span>
        </div>
      ) : null}
    </section>
  );
}
