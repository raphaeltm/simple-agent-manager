import { Spinner } from '@simple-agent-manager/ui';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Outlet,Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { AuthProvider } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageViewTracker } from './components/PageViewTracker';
import { ProtectedRoute } from './components/ProtectedRoute';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { GlobalAudioProvider } from './contexts/GlobalAudioContext';
import { ToastProvider } from './hooks/useToast';
// Eager imports — frequently visited routes for perceived performance
import { Dashboard } from './pages/Dashboard';
import { Landing } from './pages/Landing';
import { Project } from './pages/Project';
import { ProjectChat } from './pages/project-chat';
import { Projects } from './pages/Projects';

// Lazy imports — heavy or rarely visited pages
const AccountMap = lazy(() => import('./pages/AccountMap').then(m => ({ default: m.AccountMap })));
const Admin = lazy(() => import('./pages/Admin').then(m => ({ default: m.Admin })));
const AdminAnalytics = lazy(() => import('./pages/AdminAnalytics').then(m => ({ default: m.AdminAnalytics })));
const AdminErrors = lazy(() => import('./pages/AdminErrors').then(m => ({ default: m.AdminErrors })));
const AdminLogs = lazy(() => import('./pages/AdminLogs').then(m => ({ default: m.AdminLogs })));
const AdminOverview = lazy(() => import('./pages/AdminOverview').then(m => ({ default: m.AdminOverview })));
const AdminStream = lazy(() => import('./pages/AdminStream').then(m => ({ default: m.AdminStream })));
const AdminUsers = lazy(() => import('./pages/AdminUsers').then(m => ({ default: m.AdminUsers })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const CreateWorkspace = lazy(() => import('./pages/CreateWorkspace').then(m => ({ default: m.CreateWorkspace })));
const IdeaDetailPage = lazy(() => import('./pages/IdeaDetailPage').then(m => ({ default: m.IdeaDetailPage })));
const IdeasPage = lazy(() => import('./pages/IdeasPage').then(m => ({ default: m.IdeasPage })));
const Node = lazy(() => import('./pages/Node').then(m => ({ default: m.Node })));
const Nodes = lazy(() => import('./pages/Nodes').then(m => ({ default: m.Nodes })));
const ProjectActivity = lazy(() => import('./pages/ProjectActivity').then(m => ({ default: m.ProjectActivity })));
const ProjectCreate = lazy(() => import('./pages/ProjectCreate').then(m => ({ default: m.ProjectCreate })));
const ProjectLibrary = lazy(() => import('./pages/ProjectLibrary').then(m => ({ default: m.ProjectLibrary })));
const ProjectNotifications = lazy(() => import('./pages/ProjectNotifications').then(m => ({ default: m.ProjectNotifications })));
const ProjectSettings = lazy(() => import('./pages/ProjectSettings').then(m => ({ default: m.ProjectSettings })));
const ProjectTriggerDetail = lazy(() => import('./pages/ProjectTriggerDetail').then(m => ({ default: m.ProjectTriggerDetail })));
const ProjectTriggers = lazy(() => import('./pages/ProjectTriggers').then(m => ({ default: m.ProjectTriggers })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const SettingsAgentConfig = lazy(() => import('./pages/SettingsAgentConfig').then(m => ({ default: m.SettingsAgentConfig })));
const SettingsAgentKeys = lazy(() => import('./pages/SettingsAgentKeys').then(m => ({ default: m.SettingsAgentKeys })));
const SettingsCloudProvider = lazy(() => import('./pages/SettingsCloudProvider').then(m => ({ default: m.SettingsCloudProvider })));
const SettingsGitHub = lazy(() => import('./pages/SettingsGitHub').then(m => ({ default: m.SettingsGitHub })));
const SettingsNotifications = lazy(() => import('./pages/SettingsNotifications').then(m => ({ default: m.SettingsNotifications })));
const SettingsSmokeTestTokens = lazy(() => import('./pages/SettingsSmokeTestTokens').then(m => ({ default: m.SettingsSmokeTestTokens })));
const TaskDetail = lazy(() => import('./pages/TaskDetail').then(m => ({ default: m.TaskDetail })));
const UiStandards = lazy(() => import('./pages/UiStandards').then(m => ({ default: m.UiStandards })));
const Workspace = lazy(() => import('./pages/workspace').then(m => ({ default: m.Workspace })));
const Workspaces = lazy(() => import('./pages/Workspaces').then(m => ({ default: m.Workspaces })));

function LazyFallback() {
  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <Spinner size="md" />
    </div>
  );
}

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
        <Suspense fallback={<LazyFallback />}>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<RouteErrorBoundary label="landing"><Landing /></RouteErrorBoundary>} />

          {/* Protected routes with AppShell (persistent navigation) */}
          <Route element={<ProtectedLayout />}>
            <Route path="/dashboard" element={<RouteErrorBoundary label="dashboard"><Dashboard /></RouteErrorBoundary>} />
            <Route path="/chats" element={<RouteErrorBoundary label="chats"><Chats /></RouteErrorBoundary>} />
            <Route path="/projects" element={<RouteErrorBoundary label="projects"><Projects /></RouteErrorBoundary>} />
            <Route path="/projects/new" element={<RouteErrorBoundary label="project-create"><ProjectCreate /></RouteErrorBoundary>} />

            {/* Project detail — shell with sub-routes */}
            <Route path="/projects/:id" element={<RouteErrorBoundary label="project"><Project /></RouteErrorBoundary>}>
              <Route index element={<Navigate to="chat" replace />} />
              <Route path="chat" element={<RouteErrorBoundary label="project-chat"><ProjectChat /></RouteErrorBoundary>} />
              <Route path="chat/:sessionId" element={<RouteErrorBoundary label="project-chat"><ProjectChat /></RouteErrorBoundary>} />
              <Route path="library" element={<RouteErrorBoundary label="project-library"><ProjectLibrary /></RouteErrorBoundary>} />
              <Route path="ideas" element={<RouteErrorBoundary label="ideas"><IdeasPage /></RouteErrorBoundary>} />
              <Route path="ideas/:taskId" element={<RouteErrorBoundary label="idea-detail"><IdeaDetailPage /></RouteErrorBoundary>} />
              <Route path="tasks" element={<Navigate to="../ideas" replace />} />
              <Route path="tasks/:taskId" element={<RouteErrorBoundary label="task-detail"><TaskDetail /></RouteErrorBoundary>} />
              <Route path="settings" element={<RouteErrorBoundary label="project-settings"><ProjectSettings /></RouteErrorBoundary>} />
              <Route path="activity" element={<RouteErrorBoundary label="project-activity"><ProjectActivity /></RouteErrorBoundary>} />
              <Route path="notifications" element={<RouteErrorBoundary label="project-notifications"><ProjectNotifications /></RouteErrorBoundary>} />
              <Route path="triggers" element={<RouteErrorBoundary label="project-triggers"><ProjectTriggers /></RouteErrorBoundary>} />
              <Route path="triggers/:triggerId" element={<RouteErrorBoundary label="trigger-detail"><ProjectTriggerDetail /></RouteErrorBoundary>} />
            </Route>

            <Route path="/nodes" element={<RouteErrorBoundary label="nodes"><Nodes /></RouteErrorBoundary>} />
            <Route path="/nodes/:id" element={<RouteErrorBoundary label="node"><Node /></RouteErrorBoundary>} />
            <Route path="/workspaces" element={<RouteErrorBoundary label="workspaces"><Workspaces /></RouteErrorBoundary>} />
            <Route path="/workspaces/new" element={<RouteErrorBoundary label="create-workspace"><CreateWorkspace /></RouteErrorBoundary>} />
            <Route path="/settings" element={<RouteErrorBoundary label="settings"><Settings /></RouteErrorBoundary>}>
              <Route index element={<Navigate to="cloud-provider" replace />} />
              <Route path="cloud-provider" element={<RouteErrorBoundary label="settings-cloud"><SettingsCloudProvider /></RouteErrorBoundary>} />
              <Route path="github" element={<RouteErrorBoundary label="settings-github"><SettingsGitHub /></RouteErrorBoundary>} />
              <Route path="agent-keys" element={<RouteErrorBoundary label="settings-agent-keys"><SettingsAgentKeys /></RouteErrorBoundary>} />
              <Route path="agent-config" element={<RouteErrorBoundary label="settings-agent-config"><SettingsAgentConfig /></RouteErrorBoundary>} />
              <Route path="notifications" element={<RouteErrorBoundary label="settings-notifications"><SettingsNotifications /></RouteErrorBoundary>} />
              <Route path="smoke-test-tokens" element={<RouteErrorBoundary label="settings-smoke-tokens"><SettingsSmokeTestTokens /></RouteErrorBoundary>} />
            </Route>
            <Route path="/account-map" element={<RouteErrorBoundary label="account-map"><AccountMap /></RouteErrorBoundary>} />
            <Route path="/ui-standards" element={<RouteErrorBoundary label="ui-standards"><UiStandards /></RouteErrorBoundary>} />
            <Route path="/admin" element={<RouteErrorBoundary label="admin"><Admin /></RouteErrorBoundary>}>
              <Route index element={<Navigate to="users" replace />} />
              <Route path="users" element={<RouteErrorBoundary label="admin-users"><AdminUsers /></RouteErrorBoundary>} />
              <Route path="errors" element={<RouteErrorBoundary label="admin-errors"><AdminErrors /></RouteErrorBoundary>} />
              <Route path="overview" element={<RouteErrorBoundary label="admin-overview"><AdminOverview /></RouteErrorBoundary>} />
              <Route path="logs" element={<RouteErrorBoundary label="admin-logs"><AdminLogs /></RouteErrorBoundary>} />
              <Route path="stream" element={<RouteErrorBoundary label="admin-stream"><AdminStream /></RouteErrorBoundary>} />
              <Route path="analytics" element={<RouteErrorBoundary label="admin-analytics"><AdminAnalytics /></RouteErrorBoundary>} />
            </Route>
          </Route>

          {/* Workspace — NO AppShell (full-width terminal) */}
          <Route
            path="/workspaces/:id"
            element={
              <ProtectedRoute>
                <RouteErrorBoundary label="workspace">
                  <Workspace />
                </RouteErrorBoundary>
              </ProtectedRoute>
            }
          />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
      </GlobalAudioProvider>
    </ToastProvider>
    </AuthProvider>
    </ErrorBoundary>
  );
}
