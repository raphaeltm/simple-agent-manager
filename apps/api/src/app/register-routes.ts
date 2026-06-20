import { accountMapRoutes } from '../routes/account-map';
import { activityRoutes } from '../routes/activity';
import { adminRoutes } from '../routes/admin';
import { adminAiAllowanceRoutes } from '../routes/admin-ai-allowance';
import { adminAIProxyRoutes } from '../routes/admin-ai-proxy';
import { adminAiUsageRoutes } from '../routes/admin-ai-usage';
import { adminAnalyticsRoutes } from '../routes/admin-analytics';
import { adminCcBackfillRoutes } from '../routes/admin-cc-backfill';
import { adminCostRoutes } from '../routes/admin-costs';
import { adminGithubInstallationLeakSweepRoutes } from '../routes/admin-github-installation-leak-sweep';
import { adminGithubRepoIdBackfillRoutes } from '../routes/admin-github-repo-id-backfill';
import { adminPlatformCredentialRoutes } from '../routes/admin-platform-credentials';
import { adminQuotaRoutes } from '../routes/admin-quotas';
import { adminSandboxRoutes } from '../routes/admin-sandbox';
import { adminUsageRoutes } from '../routes/admin-usage';
import { agentRoutes } from '../routes/agent';
import { agentProfileRoutes } from '../routes/agent-profiles';
import { agentSettingsRoutes } from '../routes/agent-settings';
import { agentsCatalogRoutes } from '../routes/agents-catalog';
import { aiProxyRoutes } from '../routes/ai-proxy';
import { aiProxyAnthropicRoutes } from '../routes/ai-proxy-anthropic';
import { aiProxyPassthroughRoutes } from '../routes/ai-proxy-passthrough';
import { analyticsIngestRoutes } from '../routes/analytics-ingest';
import { apiTokenRoutes } from '../routes/api-tokens';
import { authRoutes } from '../routes/auth';
import { bootstrapRoutes } from '../routes/bootstrap';
import { cachedCommandRoutes } from '../routes/cached-commands';
import { chatRoutes } from '../routes/chat';
import { chatsRoutes } from '../routes/chats';
import { cliRoutes } from '../routes/cli';
import { clientErrorsRoutes } from '../routes/client-errors';
import { codexRefreshRoutes } from '../routes/codex-refresh';
import { ccRoutes } from '../routes/composable-credentials';
import { credentialsRoutes } from '../routes/credentials';
import { dashboardRoutes } from '../routes/dashboard';
import { deployReleaseCallbackRoute } from '../routes/deploy-release-callback';
import { deploymentEnvironmentRoutes } from '../routes/deployment-environments';
import { deploymentReleaseRoutes } from '../routes/deployment-releases';
import { deploymentSecretRoutes } from '../routes/deployment-secrets';
import { deploymentVolumeRoutes } from '../routes/deployment-volumes';
import { deviceFlowRoutes } from '../routes/device-flow';
import { gcpRoutes } from '../routes/gcp';
import { githubRoutes } from '../routes/github';
import { googleAuthRoutes } from '../routes/google-auth';
import { knowledgeRoutes } from '../routes/knowledge';
import { libraryRoutes } from '../routes/library';
import { mailboxRoutes } from '../routes/mailbox';
import { missionRoutes } from '../routes/missions';
import { nodeLifecycleRoutes } from '../routes/node-lifecycle';
import { nodesRoutes } from '../routes/nodes';
import { notificationRoutes } from '../routes/notifications';
import { observabilityIngestRoutes } from '../routes/observability-ingest';
import { orchestratorRoutes } from '../routes/orchestrator';
import { policyRoutes } from '../routes/policies';
import { profileRuntimeRoutes } from '../routes/profile-runtime';
import { projectAgentRoutes } from '../routes/project-agent';
import { deploymentIdentityTokenRoute, gcpDeployCallbackRoute, projectDeploymentRoutes } from '../routes/project-deployment';
import { projectsRoutes } from '../routes/projects';
import { agentActivityCallbackRoute } from '../routes/projects/agent-activity-callback';
import { nodeAcpHeartbeatRoute } from '../routes/projects/node-acp-heartbeat';
import { providersRoutes } from '../routes/providers';
import { resolutionStatusRoute } from '../routes/resolution-status';
import { samRoutes } from '../routes/sam';
import { skillRuntimeRoutes } from '../routes/skill-runtime';
import { skillRoutes } from '../routes/skills';
import { taskCallbackRoute, tasksRoutes } from '../routes/tasks';
import { terminalRoutes } from '../routes/terminal';
import { transcribeRoutes } from '../routes/transcribe';
import { trialRoutes } from '../routes/trial';
import { trialOnboardingRoutes } from '../routes/trial/index';
import { triggersRoutes } from '../routes/triggers';
import { ttsRoutes } from '../routes/tts';
import { uiGovernanceRoutes } from '../routes/ui-governance';
import { usageRoutes } from '../routes/usage';
import { workspacesRoutes } from '../routes/workspaces';
import type { ApiApp } from './types';

export function registerApiRoutes(app: ApiApp): void {
  registerAuthPrecedenceRoutes(app);
  registerCredentialProviderAndNodeRoutes(app);
  registerWorkspaceAndAgentRoutes(app);
  registerProjectCallbackRoutesBeforeSessionAuthRoutes(app);
  registerProjectSessionAndChildRoutes(app);
  registerDeploymentRoutes(app);
  registerAdminRoutes(app);
  registerProductRoutes(app);
  registerAiAndExternalAuthRoutes(app);
}

export function registerAuthPrecedenceRoutes(app: ApiApp): void {
  // These `/api/auth` routes use callback/API-token/device-flow auth and must run
  // before BetterAuth's wildcard catch-all mounted by `authRoutes`.
  app.route('/api/auth', codexRefreshRoutes);
  app.route('/api/auth', apiTokenRoutes);
  app.route('/api/auth', deviceFlowRoutes);
  app.route('/api/auth', authRoutes);
}

function registerCredentialProviderAndNodeRoutes(app: ApiApp): void {
  app.route('/api/credentials', resolutionStatusRoute);
  app.route('/api/credentials', credentialsRoutes);
  app.route('/api/cc', ccRoutes);
  app.route('/api/providers', providersRoutes);
  app.route('/api/github', githubRoutes);

  // Deploy release callback uses callback JWT auth and must be before session-auth node routes.
  app.route('/api/nodes', deployReleaseCallbackRoute);
  app.route('/api/nodes', nodesRoutes);
  app.route('/api/nodes', nodeLifecycleRoutes);
}

function registerWorkspaceAndAgentRoutes(app: ApiApp): void {
  app.route('/api/workspaces', workspacesRoutes);
  app.route('/api/terminal', terminalRoutes);
  app.route('/api/agent', agentRoutes);
  app.route('/api/agents', agentsCatalogRoutes);
  app.route('/api/bootstrap', bootstrapRoutes);
  app.route('/api/ui-governance', uiGovernanceRoutes);
  app.route('/api/transcribe', transcribeRoutes);
  app.route('/api/tts', ttsRoutes);
  app.route('/api/agent-settings', agentSettingsRoutes);
  app.route('/api/client-errors', clientErrorsRoutes);
  app.route('/api/cli', cliRoutes);
  app.route('/api/chats', chatsRoutes);
  app.route('/api/t', analyticsIngestRoutes);
}

export function registerProjectCallbackRoutesBeforeSessionAuthRoutes(app: ApiApp): void {
  // Callback JWT routes must be registered before `projectsRoutes`, whose
  // wildcard BetterAuth session middleware otherwise catches same-base siblings.
  app.route('/api/projects', deploymentIdentityTokenRoute);
  app.route('/api/projects', nodeAcpHeartbeatRoute);
  app.route('/api/projects', agentActivityCallbackRoute);
  app.route('/api/projects', taskCallbackRoute);
}

function registerProjectSessionAndChildRoutes(app: ApiApp): void {
  app.route('/api/projects', projectsRoutes);
  app.route('/api/projects/:projectId/tasks', tasksRoutes);
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  app.route('/api/projects/:projectId/cached-commands', cachedCommandRoutes);
  app.route('/api/projects/:projectId/activity', activityRoutes);
  app.route('/api/projects/:projectId/library', libraryRoutes);
  app.route('/api/projects/:projectId/agent-profiles/:profileId/runtime', profileRuntimeRoutes);
  app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
  app.route('/api/projects/:projectId/skills/:skillId/runtime', skillRuntimeRoutes);
  app.route('/api/projects/:projectId/skills', skillRoutes);
  app.route('/api/projects/:projectId/triggers', triggersRoutes);
  app.route('/api/projects/:projectId/knowledge', knowledgeRoutes);
  app.route('/api/projects/:projectId/mailbox', mailboxRoutes);
  app.route('/api/projects/:projectId/missions', missionRoutes);
  app.route('/api/projects/:projectId/orchestrator', orchestratorRoutes);
  app.route('/api/projects/:projectId/policies', policyRoutes);
  app.route('/api/projects/:projectId/agent', projectAgentRoutes);
}

function registerDeploymentRoutes(app: ApiApp): void {
  app.route('/api/projects', projectDeploymentRoutes);
  app.route('/api/projects', deploymentEnvironmentRoutes);
  app.route('/api/projects', deploymentReleaseRoutes);
  app.route('/api/projects', deploymentSecretRoutes);
  app.route('/api/projects', deploymentVolumeRoutes);
  app.route('/api/deployment', gcpDeployCallbackRoute);
}

function registerAdminRoutes(app: ApiApp): void {
  app.route('/api/admin/observability/logs/ingest', observabilityIngestRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin/ai-proxy', adminAIProxyRoutes);
  app.route('/api/admin/analytics', adminAnalyticsRoutes);
  app.route('/api/admin/analytics/ai-usage', adminAiUsageRoutes);
  app.route('/api/admin/platform-credentials', adminPlatformCredentialRoutes);
  app.route('/api/admin/quotas', adminQuotaRoutes);
  app.route('/api/admin/usage', adminUsageRoutes);
  app.route('/api/admin/costs', adminCostRoutes);
  app.route('/api/admin/cc-backfill', adminCcBackfillRoutes);
  app.route('/api/admin/github-repo-id-backfill', adminGithubRepoIdBackfillRoutes);
  app.route('/api/admin/github-installation-leak-sweep', adminGithubInstallationLeakSweepRoutes);
  app.route('/api/admin/sandbox', adminSandboxRoutes);
  app.route('/api/admin/ai-allowance', adminAiAllowanceRoutes);
}

function registerProductRoutes(app: ApiApp): void {
  app.route('/api/usage', usageRoutes);
  app.route('/api/account-map', accountMapRoutes);
  app.route('/api/dashboard', dashboardRoutes);
  app.route('/api/sam', samRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api', trialRoutes);
  app.route('/api/trial', trialOnboardingRoutes);
  app.route('/api/gcp', gcpRoutes);
}

function registerAiAndExternalAuthRoutes(app: ApiApp): void {
  app.route('/ai/v1', aiProxyRoutes);
  app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
  app.route('/ai/proxy', aiProxyPassthroughRoutes);
  app.route('/auth/google', googleAuthRoutes);
}
