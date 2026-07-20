import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { AuthProvider, useAuth } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageViewTracker } from './components/PageViewTracker';
import { ProtectedRoute } from './components/ProtectedRoute';
import { GlobalAudioProvider } from './contexts/GlobalAudioContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './hooks/useToast';
import { queryClient } from './lib/query-client';
import { AccountMap } from './pages/AccountMap';
import { Admin } from './pages/Admin';
import { AdminAIProxy } from './pages/AdminAIProxy';
import { AdminAnalytics } from './pages/AdminAnalytics';
import { AdminComputeQuotas } from './pages/AdminComputeQuotas';
import { AdminComputeUsage } from './pages/AdminComputeUsage';
import { AdminCosts } from './pages/AdminCosts';
import { AdminErrors } from './pages/AdminErrors';
import { AdminLogs } from './pages/AdminLogs';
import { AdminOverview } from './pages/AdminOverview';
import { AdminPlatformConfig } from './pages/AdminPlatformConfig';
import { AdminPlatformCredentials } from './pages/AdminPlatformCredentials';
import { AdminStream } from './pages/AdminStream';
import { AdminTrials } from './pages/AdminTrials';
import { AdminUsers } from './pages/AdminUsers';
import { AgentContextPage } from './pages/AgentContextPage';
import { Chats } from './pages/Chats';
import { CreateWorkspace } from './pages/CreateWorkspace';
import { Dashboard } from './pages/Dashboard';
import { DeviceAuth } from './pages/DeviceAuth';
import { IdeaDetailPage } from './pages/IdeaDetailPage';
import { IdeasPage } from './pages/IdeasPage';
import { Landing } from './pages/Landing';
import { Node } from './pages/Node';
import { Nodes } from './pages/Nodes';
import { Project } from './pages/Project';
import { ProjectChat } from './pages/project-chat';
import { ProjectActivity } from './pages/ProjectActivity';
import { ProjectAgentChat } from './pages/ProjectAgentChat';
import { ProjectCreate } from './pages/ProjectCreate';
import { ProjectDeploymentEnvironmentDetail } from './pages/ProjectDeploymentEnvironmentDetail';
import { ProjectDeployments } from './pages/ProjectDeployments';
import { ProjectFiles } from './pages/ProjectFiles';
import { ProjectInvite } from './pages/ProjectInvite';
import { ProjectLibrary } from './pages/ProjectLibrary';
import { ProjectNotifications } from './pages/ProjectNotifications';
import { ProjectProfiles } from './pages/ProjectProfiles';
import { Projects } from './pages/Projects';
import {
  ProjectSettings,
  ProjectSettingsAccess,
  ProjectSettingsAgents,
  ProjectSettingsConnections,
  ProjectSettingsDeploy,
  ProjectSettingsGeneral,
  ProjectSettingsIndexRedirect,
  ProjectSettingsInfrastructure,
  ProjectSettingsRuntime,
} from './pages/ProjectSettings';
import { ProjectSkills } from './pages/ProjectSkills';
import { ProjectTriggerDetail } from './pages/ProjectTriggerDetail';
import { ProjectTriggers } from './pages/ProjectTriggers';
import { SamPrototype } from './pages/SamPrototype';
import { Settings } from './pages/Settings';
import { SettingsAgents } from './pages/SettingsAgents';
import { SettingsApiTokens } from './pages/SettingsApiTokens';
import { SettingsCloudProvider } from './pages/SettingsCloudProvider';
import { SettingsComputeUsage } from './pages/SettingsComputeUsage';
import { SettingsConnections } from './pages/SettingsConnections';
import { SettingsCredentials } from './pages/SettingsCredentials';
import { SettingsGitHub } from './pages/SettingsGitHub';
import { SettingsNotifications } from './pages/SettingsNotifications';
import { Setup } from './pages/Setup';
import { TaskRedirect } from './pages/TaskRedirect';
import { Tools } from './pages/Tools';
import { ToolsCli } from './pages/ToolsCli';
import { TrialChatGateHarness } from './pages/TrialChatGateHarness';
import { Try } from './pages/Try';
import { TryCapExceeded } from './pages/TryCapExceeded';
import { TryDiscovery } from './pages/TryDiscovery';
import { TryWaitlistThanks } from './pages/TryWaitlistThanks';
import { UiStandards } from './pages/UiStandards';
import { Workspace } from './pages/workspace';
import { Workspaces } from './pages/Workspaces';

function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Outlet />
      </AppShell>
    </ProtectedRoute>
  );
}

function SuperadminRoute({ children }: { children: ReactNode }) {
  const { isSuperadmin } = useAuth();

  if (!isSuperadmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

export const DEV_ONLY_ROUTE_PATHS = ['/sam', '/__test/trial-chat-gate', '/ui-standards'] as const;

export function devOnlyRoutesEnabled() {
  return import.meta.env.DEV || import.meta.env.MODE === 'test';
}

export default function App() {
  const showDevOnlyRoutes = devOnlyRoutesEnabled();

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ToastProvider>
              <GlobalAudioProvider>
                <BrowserRouter>
                  <PageViewTracker />
                  <Routes>
                    {/* Public routes */}
                    <Route path="/" element={<Landing />} />
                    <Route path="/try" element={<Try />} />
                    <Route path="/try/cap-exceeded" element={<TryCapExceeded />} />
                    <Route path="/try/waitlist/thanks" element={<TryWaitlistThanks />} />
                    <Route path="/try/:trialId" element={<TryDiscovery />} />
                    <Route path="/device" element={<DeviceAuth />} />
                    <Route path="/setup" element={<Setup />} />
                    {showDevOnlyRoutes && (
                      <>
                        {/* SAM prototype — local/test only, no auth */}
                        <Route path="/sam" element={<SamPrototype />} />
                        {/* Harness for Playwright audits — mounts trial components with mock data */}
                        <Route path="/__test/trial-chat-gate" element={<TrialChatGateHarness />} />
                      </>
                    )}
                    {/* Protected routes with AppShell (persistent navigation) */}
                    <Route element={<ProtectedLayout />}>
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/chats" element={<Chats />} />
                      <Route path="/projects" element={<Projects />} />
                      <Route path="/projects/new" element={<ProjectCreate />} />
                      <Route path="/projects/invite/:token" element={<ProjectInvite />} />

                      {/* Project detail — shell with sub-routes */}
                      <Route path="/projects/:id" element={<Project />}>
                        <Route index element={<Navigate to="chat" replace />} />
                        <Route path="chat" element={<ProjectChat />} />
                        <Route path="chat/:sessionId" element={<ProjectChat />} />
                        <Route path="agent" element={<ProjectAgentChat />} />
                        <Route path="library" element={<ProjectLibrary />} />
                        <Route path="files" element={<ProjectFiles />} />
                        <Route path="ideas" element={<IdeasPage />} />
                        <Route path="deployments" element={<ProjectDeployments />} />
                        <Route
                          path="deployments/:envId"
                          element={<ProjectDeploymentEnvironmentDetail />}
                        />
                        <Route path="agent-context" element={<AgentContextPage />} />
                        <Route
                          path="knowledge"
                          element={<Navigate to="../agent-context" replace />}
                        />
                        <Route path="ideas/:taskId" element={<IdeaDetailPage />} />
                        <Route path="tasks" element={<Navigate to="../ideas" replace />} />
                        <Route path="tasks/:taskId" element={<TaskRedirect />} />
                        <Route path="settings" element={<ProjectSettings />}>
                          <Route index element={<ProjectSettingsIndexRedirect />} />
                          <Route path="general" element={<ProjectSettingsGeneral />} />
                          <Route path="access" element={<ProjectSettingsAccess />} />
                          <Route path="connections" element={<ProjectSettingsConnections />} />
                          <Route path="agents" element={<ProjectSettingsAgents />} />
                          <Route
                            path="infrastructure"
                            element={<ProjectSettingsInfrastructure />}
                          />
                          <Route path="runtime" element={<ProjectSettingsRuntime />} />
                          <Route path="deploy" element={<ProjectSettingsDeploy />} />
                        </Route>
                        <Route path="activity" element={<ProjectActivity />} />
                        <Route path="notifications" element={<ProjectNotifications />} />
                        <Route path="triggers" element={<ProjectTriggers />} />
                        <Route path="triggers/:triggerId" element={<ProjectTriggerDetail />} />
                        <Route path="profiles" element={<ProjectProfiles />} />
                        <Route path="skills" element={<ProjectSkills />} />
                      </Route>

                      <Route path="/nodes" element={<Nodes />} />
                      <Route path="/nodes/:id" element={<Node />} />
                      <Route path="/workspaces" element={<Workspaces />} />
                      <Route path="/workspaces/new" element={<CreateWorkspace />} />
                      <Route path="/settings" element={<Settings />}>
                        <Route index element={<Navigate to="cloud-provider" replace />} />
                        <Route path="cloud-provider" element={<SettingsCloudProvider />} />
                        <Route path="github" element={<SettingsGitHub />} />
                        <Route path="connections" element={<SettingsConnections />} />
                        <Route path="agents" element={<SettingsAgents />} />
                        <Route
                          path="agent-keys"
                          element={<Navigate to="../connections" replace />}
                        />
                        <Route
                          path="agent-config"
                          element={<Navigate to="../connections" replace />}
                        />
                        <Route path="notifications" element={<SettingsNotifications />} />
                        <Route path="usage" element={<SettingsComputeUsage />} />
                        <Route path="api-tokens" element={<SettingsApiTokens />} />
                        <Route path="advanced" element={<SettingsCredentials />} />
                        <Route path="credentials" element={<Navigate to="../advanced" replace />} />
                      </Route>
                      <Route path="/account-map" element={<AccountMap />} />
                      <Route path="/tools" element={<Tools />} />
                      <Route path="/tools/cli" element={<ToolsCli />} />
                      {showDevOnlyRoutes && (
                        <Route path="/ui-standards" element={<UiStandards />} />
                      )}
                      <Route
                        path="/admin"
                        element={
                          <SuperadminRoute>
                            <Admin />
                          </SuperadminRoute>
                        }
                      >
                        <Route index element={<Navigate to="users" replace />} />
                        <Route path="users" element={<AdminUsers />} />
                        <Route path="integrations" element={<AdminPlatformConfig />} />
                        <Route path="credentials" element={<AdminPlatformCredentials />} />
                        <Route path="ai-proxy" element={<AdminAIProxy />} />
                        <Route path="trials" element={<AdminTrials />} />
                        <Route path="costs" element={<AdminCosts />} />
                        <Route path="usage" element={<AdminComputeUsage />} />
                        <Route path="quotas" element={<AdminComputeQuotas />} />
                        <Route path="errors" element={<AdminErrors />} />
                        <Route path="overview" element={<AdminOverview />} />
                        <Route path="logs" element={<AdminLogs />} />
                        <Route path="stream" element={<AdminStream />} />
                        <Route path="analytics" element={<AdminAnalytics />} />
                      </Route>
                    </Route>

                    {/* Workspace — NO AppShell (full-width terminal) */}
                    <Route
                      path="/workspaces/:id"
                      element={
                        <ProtectedRoute>
                          <Workspace />
                        </ProtectedRoute>
                      }
                    />

                    {/* Fallback */}
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </BrowserRouter>
              </GlobalAudioProvider>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
