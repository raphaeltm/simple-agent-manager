/** Browser-only harness for the actual shipped components; never routed by the app. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { NodeCard } from '../../../src/components/node/NodeCard';
import { NodeOverviewSection } from '../../../src/components/node/NodeOverviewSection';
import { WorkspaceCard } from '../../../src/components/WorkspaceCard';
import { WorkspaceSidebar } from '../../../src/components/WorkspaceSidebar';
import { SessionHeaderInfrastructure } from '../../../src/components/project-message-view/SessionHeaderInfrastructure';
import { NodeSection } from '../../../src/pages/ProjectDeploymentEnvironmentDetail';
import { UserDetail } from '../../../src/pages/AdminComputeUsage';
import { SettingsComputeUsage } from '../../../src/pages/SettingsComputeUsage';
import type { ChatSessionResponse } from '../../../src/lib/api';
import type { DeploymentEnvironment } from '../../../src/lib/api/deployment';
import '../../../src/app.css';
import '../../../src/index.css';
import '../../../src/styles/acp-chat.css';
import '../../../src/styles/workspace-chrome.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario');
const surface = params.get('surface');
const name =
  scenario === 'long'
    ? 'Native provider / 区域 🚀 <script>alert(1)</script> '.repeat(8)
    : 'Native compute';
const native =
  scenario === 'legacy'
    ? {}
    : {
        providerInstanceType: scenario === 'long' ? 'native-sku-'.repeat(28) : 'cx53',
        providerInstanceVcpuCount: 16,
        providerInstanceMemoryMb: 32768,
        providerInstanceDiskGb: 320,
        observedProviderInstanceType: 'cx53',
        observedProviderInstanceVcpuCount: 12,
        observedProviderInstanceMemoryMb: 30720,
        observedProviderInstanceDiskGb: 300,
      };
const node: NodeResponse = {
  id: 'native-node',
  name,
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'small',
  vmLocation: 'nbg1',
  cloudProvider: 'hetzner',
  nodeRole: 'workspace',
  ipAddress: null,
  lastHeartbeatAt: null,
  createdAt: '2026-09-07T10:00:00Z',
  updatedAt: '2026-09-07T10:00:00Z',
  errorMessage:
    scenario === 'error' ? 'Provider capacity unavailable. Retry when capacity returns.' : null,
  ...native,
};
const placementExplanationJson = JSON.stringify({
  diagnostics: {
    version: 1,
    requested: { cpuMillis: 2500, memoryMb: 5120, diskMb: 10240, evidence: 'requested' },
    ...(scenario === 'error'
      ? { rollout: { mode: 'shadow', configuredStrategy: 'pack', appliedStrategy: 'balanced' } }
      : {}),
    selectedNodeId: scenario === 'error' ? null : node.id,
    authority: {
      capacityPoolScope: 'installation',
      effectivePoolState: scenario === 'error' ? 'catalog-unavailable' : 'configured-ready',
      strategy: scenario === 'error' ? 'balanced' : 'pack',
      strategyOrdering:
        scenario === 'error'
          ? 'lowest projected utilization first'
          : 'highest projected utilization first',
      revalidatedAgainstCurrentAuthority: scenario !== 'error',
    },
    hosts: [],
    queue: { state: scenario === 'error' ? 'waiting' : null, nextRetryAt: null, reason: null },
  },
});
const workspace: WorkspaceResponse = {
  id: 'native-workspace',
  nodeId: node.id,
  name,
  displayName: name,
  status: 'running',
  projectId: 'native-project',
  repository: 'sam/migration',
  branch: 'main',
  vmSize: 'small',
  vmLocation: 'nbg1',
  vmIp: null,
  lastActivityAt: null,
  errorMessage: node.errorMessage,
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
  hardware: node,
  placementExplanationJson: scenario === 'legacy' ? null : placementExplanationJson,
  resolvedReservationJson:
    scenario === 'legacy'
      ? null
      : JSON.stringify({
          cpuMillis: 2500,
          memoryMb: 5120,
          diskMb: 10240,
          exclusiveNode: false,
          maxCoTenants: 3,
          source: 'project',
          sourceId: 'PRIVATE-IDENTITY',
          credentialId: 'SECRET-MUST-NOT-RENDER',
        }),
};
const noop = () => {};
const workspaces =
  scenario === 'empty'
    ? []
    : Array.from({ length: scenario === 'many' ? 35 : 2 }, (_, i) => ({
        ...workspace,
        id: `ws-${i}`,
      }));
function Surface() {
  if (surface === 'node-card')
    return (
      <NodeCard
        node={node}
        workspaces={workspaces}
        onStop={noop}
        onDelete={noop}
        onCreateWorkspace={noop}
      />
    );
  if (surface === 'node-detail') return <NodeOverviewSection node={node} />;
  if (surface === 'workspace-card') return <WorkspaceCard workspace={workspace} />;
  if (surface === 'session-infrastructure')
    return (
      <SessionHeaderInfrastructure
        session={{ workspaceId: scenario === 'error' ? null : workspace.id } as ChatSessionResponse}
        workspace={scenario === 'error' ? null : workspace}
        node={scenario === 'error' ? null : node}
        taskEmbed={{ id: 'task', placementExplanationJson }}
        detectedPorts={[]}
        getWorkspacePortHref={() => ''}
      />
    );
  if (surface === 'deployment')
    return <NodeSection env={{ node } as unknown as DeploymentEnvironment} />;
  if (surface === 'admin-usage') return <UserDetail userId="native-user" onBack={noop} />;
  if (surface === 'usage') return <SettingsComputeUsage />;
  return (
    <div style={{ height: 1000 }}>
      <WorkspaceSidebar
        workspace={workspace}
        isRunning={false}
        isMobile={innerWidth < 768}
        actionLoading={false}
        onStop={noop}
        onRestart={noop}
        onRebuild={noop}
        displayNameInput={name}
        onDisplayNameChange={noop}
        onRename={noop}
        renaming={false}
        workspaceTabs={[]}
        activeTabId={null}
        onSelectTab={noop}
        onStopSession={noop}
        gitStatus={null}
        onOpenGitChanges={noop}
        sessionTokenUsages={[]}
        detectedPorts={[]}
        workspaceEvents={[]}
      />
    </div>
  );
}
document.documentElement.dataset.uiTheme = 'sam';
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <main style={{ padding: 12, maxWidth: 1000, margin: 'auto' }}>
      <Surface />
    </main>
  </BrowserRouter>
);
