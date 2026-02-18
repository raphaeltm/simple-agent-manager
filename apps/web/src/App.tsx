import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './components/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './hooks/useToast';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { CreateWorkspace } from './pages/CreateWorkspace';
import { Workspace } from './pages/Workspace';
import { Nodes } from './pages/Nodes';
import { Node } from './pages/Node';
import { UiStandards } from './pages/UiStandards';
import { Projects } from './pages/Projects';
import { Project } from './pages/Project';

export default function App() {
  return (
    <ErrorBoundary>
    <AuthProvider>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Landing />} />

          {/* Protected routes */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/workspaces/new"
            element={
              <ProtectedRoute>
                <CreateWorkspace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects/new"
            element={
              <ProtectedRoute>
                <CreateWorkspace mode="project" />
              </ProtectedRoute>
            }
          />
          <Route
            path="/workspaces/:id"
            element={
              <ProtectedRoute>
                <Workspace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/nodes"
            element={
              <ProtectedRoute>
                <Nodes />
              </ProtectedRoute>
            }
          />
          <Route
            path="/nodes/:id"
            element={
              <ProtectedRoute>
                <Node />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects"
            element={
              <ProtectedRoute>
                <Projects />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <ProtectedRoute>
                <Project />
              </ProtectedRoute>
            }
          />
          <Route
            path="/ui-standards"
            element={
              <ProtectedRoute>
                <UiStandards />
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
