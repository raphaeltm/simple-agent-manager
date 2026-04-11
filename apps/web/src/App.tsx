import { BrowserRouter, Navigate, Outlet,Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { AuthProvider } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageViewTracker } from './components/PageViewTracker';
import { ProtectedRoute } from './components/ProtectedRoute';
import { GlobalAudioProvider } from './contexts/GlobalAudioContext';
import { ToastProvider } from './hooks/useToast';
import { AccountMap } from './pages/AccountMap';
import { Admin } from './pages/Admin';
import { AdminAnalytics } from './pages/AdminAnalytics';
import { AdminErrors } from './pages/AdminErrors';
import { AdminLogs } from './pages/AdminLogs';
import { AdminOverview } from './pages/AdminOverview';
import { AdminComputeUsage } from './pages/AdminComputeUsage';
import { AdminPlatformCredentials } from './pages/AdminPlatformCredentials';
import { AdminStream } from './pages/AdminStream';
import { AdminUsers } from './pages/AdminUsers';
import { Chats } from './pages/Chats';
import { CreateWorkspace } from './pages/CreateWorkspace';
import { Dashboard } from './pages/Dashboard';
import { IdeaDetailPage } from './pages/IdeaDetailPage';
import { IdeasPage } from './pages/IdeasPage';
import { Landing } from './pages/Landing';
import { Node } from './pages/Node';
import { Nodes } from './pages/Nodes';
import { Project } from './pages/Project';
import { ProjectChat } from './pages/project-chat';
import { ProjectActivity } from './pages/ProjectActivity';
import { ProjectCreate } from './pages/ProjectCreate';
import { ProjectLibrary } from './pages/ProjectLibrary';
import { ProjectNotifications } from './pages/ProjectNotifications';
import { Projects } from './pages/Projects';
import { ProjectSettings } from './pages/ProjectSettings';
import { ProjectTriggerDetail } from './pages/ProjectTriggerDetail';
import { ProjectTriggers } from './pages/ProjectTriggers';
import { Settings } from './pages/Settings';
import { SettingsAgentConfig } from './pages/SettingsAgentConfig';
import { SettingsAgentKeys } from './pages/SettingsAgentKeys';
import { SettingsCloudProvider } from './pages/SettingsCloudProvider';
import { SettingsGitHub } from './pages/SettingsGitHub';
import { SettingsNotifications } from './pages/SettingsNotifications';
import { SettingsComputeUsage } from './pages/SettingsComputeUsage';
import { SettingsSmokeTestTokens } from './pages/SettingsSmokeTestTokens';
import { TaskDetail } from './pages/TaskDetail';
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

export default function App() {
  return (
    <ErrorBoundary>
    <AuthProvider>
    <ToastProvider>
      <GlobalAudioProvider>
      <BrowserRouter>
        <PageViewTracker />
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Landing />} />

          {/* Protected routes with AppShell (persistent navigation) */}
          <Route element={<ProtectedLayout />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/chats" element={<Chats />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<ProjectCreate />} />

            {/* Project detail — shell with sub-routes */}
            <Route path="/projects/:id" element={<Project />}>
              <Route index element={<Navigate to="chat" replace />} />
              <Route path="chat" element={<ProjectChat />} />
              <Route path="chat/:sessionId" element={<ProjectChat />} />
              <Route path="library" element={<ProjectLibrary />} />
              <Route path="ideas" element={<IdeasPage />} />
              <Route path="ideas/:taskId" element={<IdeaDetailPage />} />
              <Route path="tasks" element={<Navigate to="../ideas" replace />} />
              <Route path="tasks/:taskId" element={<TaskDetail />} />
              <Route path="settings" element={<ProjectSettings />} />
              <Route path="activity" element={<ProjectActivity />} />
              <Route path="notifications" element={<ProjectNotifications />} />
              <Route path="triggers" element={<ProjectTriggers />} />
              <Route path="triggers/:triggerId" element={<ProjectTriggerDetail />} />
            </Route>

            <Route path="/nodes" element={<Nodes />} />
            <Route path="/nodes/:id" element={<Node />} />
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/workspaces/new" element={<CreateWorkspace />} />
            <Route path="/settings" element={<Settings />}>
              <Route index element={<Navigate to="cloud-provider" replace />} />
              <Route path="cloud-provider" element={<SettingsCloudProvider />} />
              <Route path="github" element={<SettingsGitHub />} />
              <Route path="agent-keys" element={<SettingsAgentKeys />} />
              <Route path="agent-config" element={<SettingsAgentConfig />} />
              <Route path="notifications" element={<SettingsNotifications />} />
              <Route path="usage" element={<SettingsComputeUsage />} />
              <Route path="smoke-test-tokens" element={<SettingsSmokeTestTokens />} />
            </Route>
            <Route path="/account-map" element={<AccountMap />} />
            <Route path="/ui-standards" element={<UiStandards />} />
            <Route path="/admin" element={<Admin />}>
              <Route index element={<Navigate to="users" replace />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="credentials" element={<AdminPlatformCredentials />} />
              <Route path="usage" element={<AdminComputeUsage />} />
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
    </ErrorBoundary>
  );
}
