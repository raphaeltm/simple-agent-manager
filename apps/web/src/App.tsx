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
import { CreateWorkspace } from './pages/CreateWorkspace';
import { Workspace } from './pages/Workspace';
import { Nodes } from './pages/Nodes';
import { Node } from './pages/Node';
import { UiStandards } from './pages/UiStandards';
import { Projects } from './pages/Projects';
import { Project } from './pages/Project';
import { ProjectOverview } from './pages/ProjectOverview';
import { ProjectTasks } from './pages/ProjectTasks';
import { ProjectSessions } from './pages/ProjectSessions';
import { ProjectSettings } from './pages/ProjectSettings';
import { ProjectActivity } from './pages/ProjectActivity';
import { TaskDetail } from './pages/TaskDetail';
import { ChatSessionView } from './pages/ChatSessionView';
import { ProjectChat } from './pages/ProjectChat';
import { ProjectCreate } from './pages/ProjectCreate';
import { Admin } from './pages/Admin';

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
      <BrowserRouter>
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
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<ProjectOverview />} />
              <Route path="chat" element={<ProjectChat />} />
              <Route path="chat/:sessionId" element={<ProjectChat />} />
              <Route path="tasks" element={<ProjectTasks />} />
              <Route path="tasks/:taskId" element={<TaskDetail />} />
              <Route path="sessions" element={<ProjectSessions />} />
              <Route path="sessions/:sessionId" element={<ChatSessionView />} />
              <Route path="settings" element={<ProjectSettings />} />
              <Route path="activity" element={<ProjectActivity />} />
            </Route>

            <Route path="/nodes" element={<Nodes />} />
            <Route path="/nodes/:id" element={<Node />} />
            <Route path="/workspaces/new" element={<CreateWorkspace />} />
            <Route path="/settings" element={<Settings />}>
              <Route index element={<Navigate to="cloud-provider" replace />} />
              <Route path="cloud-provider" element={<SettingsCloudProvider />} />
              <Route path="github" element={<SettingsGitHub />} />
              <Route path="agent-keys" element={<SettingsAgentKeys />} />
              <Route path="agent-config" element={<SettingsAgentConfig />} />
            </Route>
            <Route path="/ui-standards" element={<UiStandards />} />
            <Route path="/admin" element={<Admin />} />
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
    </ToastProvider>
    </AuthProvider>
    </ErrorBoundary>
  );
}
