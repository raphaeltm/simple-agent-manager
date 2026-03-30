import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './hooks/useToast';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/AppShell';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { SettingsCloudProvider } from './pages/SettingsCloudProvider';
import { SettingsGitHub } from './pages/SettingsGitHub';
import { SettingsAgentKeys } from './pages/SettingsAgentKeys';
import { SettingsAgentConfig } from './pages/SettingsAgentConfig';
import { SettingsNotifications } from './pages/SettingsNotifications';
import { SettingsSmokeTestTokens } from './pages/SettingsSmokeTestTokens';
import { CreateWorkspace } from './pages/CreateWorkspace';
import { Workspace } from './pages/Workspace';
import { Workspaces } from './pages/Workspaces';
import { Nodes } from './pages/Nodes';
import { Node } from './pages/Node';
import { UiStandards } from './pages/UiStandards';
import { Projects } from './pages/Projects';
import { Project } from './pages/Project';
import { IdeasPage } from './pages/IdeasPage';
import { IdeaDetailPage } from './pages/IdeaDetailPage';
import { ProjectSettings } from './pages/ProjectSettings';
import { ProjectActivity } from './pages/ProjectActivity';
import { ProjectNotifications } from './pages/ProjectNotifications';
import { TaskDetail } from './pages/TaskDetail';
import { ProjectChat } from './pages/ProjectChat';
import { ProjectCreate } from './pages/ProjectCreate';
import { Admin } from './pages/Admin';
import { AdminUsers } from './pages/AdminUsers';
import { AdminErrors } from './pages/AdminErrors';
import { AdminOverview } from './pages/AdminOverview';
import { AdminLogs } from './pages/AdminLogs';
import { AdminStream } from './pages/AdminStream';
import { AdminAnalytics } from './pages/AdminAnalytics';
import { AccountMap } from './pages/AccountMap';
import { PageViewTracker } from './components/PageViewTracker';
import { GlobalAudioProvider } from './contexts/GlobalAudioContext';

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
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<ProjectCreate />} />

            {/* Project detail — shell with sub-routes */}
            <Route path="/projects/:id" element={<Project />}>
              <Route index element={<Navigate to="chat" replace />} />
              <Route path="chat" element={<ProjectChat />} />
              <Route path="chat/:sessionId" element={<ProjectChat />} />
              <Route path="ideas" element={<IdeasPage />} />
              <Route path="ideas/:taskId" element={<IdeaDetailPage />} />
              <Route path="tasks" element={<Navigate to="../ideas" replace />} />
              <Route path="tasks/:taskId" element={<TaskDetail />} />
              <Route path="settings" element={<ProjectSettings />} />
              <Route path="activity" element={<ProjectActivity />} />
              <Route path="notifications" element={<ProjectNotifications />} />
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
              <Route path="smoke-test-tokens" element={<SettingsSmokeTestTokens />} />
            </Route>
            <Route path="/account-map" element={<AccountMap />} />
            <Route path="/ui-standards" element={<UiStandards />} />
            <Route path="/admin" element={<Admin />}>
              <Route index element={<Navigate to="users" replace />} />
              <Route path="users" element={<AdminUsers />} />
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
