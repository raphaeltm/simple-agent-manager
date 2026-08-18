import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, Suspense } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { AuthProvider, useAuth } from './components/AuthProvider';
import { BackgroundFetchIndicator } from './components/BackgroundFetchIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageViewTracker } from './components/PageViewTracker';
import { ProtectedRoute } from './components/ProtectedRoute';
import { RouteFallback } from './components/RouteFallback';
import { GlobalAudioProvider } from './contexts/GlobalAudioContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './hooks/useToast';
import { lazyNamed } from './lib/lazy-with-retry';
import { queryClient } from './lib/query-client';
// Initial landing set — statically imported per .claude/rules/60-request-io-and-bundle-budgets.md.
// Every other page below is code-split via lazyNamed(). Do NOT add static page imports here.
import { Dashboard } from './pages/Dashboard';
import { Landing } from './pages/Landing';

const AccountMap = lazyNamed(() => import('./pages/AccountMap'), 'AccountMap');
const Admin = lazyNamed(() => import('./pages/Admin'), 'Admin');
const AdminAIProxy = lazyNamed(() => import('./pages/AdminAIProxy'), 'AdminAIProxy');
const AdminAnalytics = lazyNamed(() => import('./pages/AdminAnalytics'), 'AdminAnalytics');
const AdminComputeQuotas = lazyNamed(
  () => import('./pages/AdminComputeQuotas'),
  'AdminComputeQuotas'
);
const AdminComputeUsage = lazyNamed(() => import('./pages/AdminComputeUsage'), 'AdminComputeUsage');
const AdminCosts = lazyNamed(() => import('./pages/AdminCosts'), 'AdminCosts');
const AdminDiagnoses = lazyNamed(() => import('./pages/AdminDiagnoses'), 'AdminDiagnoses');
const AdminDiagnosis = lazyNamed(() => import('./pages/AdminDiagnosis'), 'AdminDiagnosis');
const AdminErrors = lazyNamed(() => import('./pages/AdminErrors'), 'AdminErrors');
const AdminLogs = lazyNamed(() => import('./pages/AdminLogs'), 'AdminLogs');
const AdminOverview = lazyNamed(() => import('./pages/AdminOverview'), 'AdminOverview');
const AdminPlatformConfig = lazyNamed(
  () => import('./pages/AdminPlatformConfig'),
  'AdminPlatformConfig'
);
const AdminPlatformCredentials = lazyNamed(
  () => import('./pages/AdminPlatformCredentials'),
  'AdminPlatformCredentials'
);
const AdminStream = lazyNamed(() => import('./pages/AdminStream'), 'AdminStream');
const AdminTrials = lazyNamed(() => import('./pages/AdminTrials'), 'AdminTrials');
const AdminUsers = lazyNamed(() => import('./pages/AdminUsers'), 'AdminUsers');
const AgentContextPage = lazyNamed(() => import('./pages/AgentContextPage'), 'AgentContextPage');
const Chats = lazyNamed(() => import('./pages/Chats'), 'Chats');
const CreateWorkspace = lazyNamed(() => import('./pages/CreateWorkspace'), 'CreateWorkspace');
const DeviceAuth = lazyNamed(() => import('./pages/DeviceAuth'), 'DeviceAuth');
const IdeaDetailPage = lazyNamed(() => import('./pages/IdeaDetailPage'), 'IdeaDetailPage');
const IdeasPage = lazyNamed(() => import('./pages/IdeasPage'), 'IdeasPage');
const Node = lazyNamed(() => import('./pages/Node'), 'Node');
const Nodes = lazyNamed(() => import('./pages/Nodes'), 'Nodes');
/**
 * `/projects/:id` renders the `Project` shell, whose `<Outlet/>` then renders a child
 * route — so the child's chunk would only START loading once the shell has rendered.
 * That sequential waterfall lands on the app's hottest path (rule 26: project chat is
 * the primary UX surface), and the shell chunk is tiny (~1 kB gzip), so the second
 * request is almost pure round-trip latency.
 *
 * Merging the two into one `advancedChunks` group was measured to be far worse — it made
 * the combined 343 kB gzip chunk eager on every page load (see `vite.config.ts`). Kicking
 * the child import off in parallel with the shell import gets the same overlap with none
 * of the initial-load cost.
 *
 * `chat` is the correct chunk to warm: `/projects/:id` index-redirects to it.
 */
const Project = lazyNamed(() => {
  const shell = import('./pages/Project');
  // Fire-and-forget: failures are surfaced by the route's own lazy import, and an
  // unhandled rejection here would be reported as a page-level error.
  void import('./pages/project-chat').catch(() => undefined);
  return shell;
}, 'Project');
const ProjectChat = lazyNamed(() => import('./pages/project-chat'), 'ProjectChat');
const ProjectActivity = lazyNamed(() => import('./pages/ProjectActivity'), 'ProjectActivity');
const ProjectAgentChat = lazyNamed(() => import('./pages/ProjectAgentChat'), 'ProjectAgentChat');
const ProjectCreate = lazyNamed(() => import('./pages/ProjectCreate'), 'ProjectCreate');
const ProjectDeploymentEnvironmentDetail = lazyNamed(
  () => import('./pages/ProjectDeploymentEnvironmentDetail'),
  'ProjectDeploymentEnvironmentDetail'
);
const ProjectDeployments = lazyNamed(
  () => import('./pages/ProjectDeployments'),
  'ProjectDeployments'
);
const ProjectFiles = lazyNamed(() => import('./pages/ProjectFiles'), 'ProjectFiles');
const ProjectInvite = lazyNamed(() => import('./pages/ProjectInvite'), 'ProjectInvite');
const ProjectLibrary = lazyNamed(() => import('./pages/ProjectLibrary'), 'ProjectLibrary');
const ProjectNotifications = lazyNamed(
  () => import('./pages/ProjectNotifications'),
  'ProjectNotifications'
);
const ProjectProfiles = lazyNamed(() => import('./pages/ProjectProfiles'), 'ProjectProfiles');
const Projects = lazyNamed(() => import('./pages/Projects'), 'Projects');
const ProjectSettings = lazyNamed(() => import('./pages/ProjectSettings'), 'ProjectSettings');
const ProjectSettingsAccess = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsAccess'
);
const ProjectSettingsAgents = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsAgents'
);
const ProjectSettingsConnections = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsConnections'
);
const ProjectSettingsDeploy = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsDeploy'
);
const ProjectSettingsGeneral = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsGeneral'
);
const ProjectSettingsIndexRedirect = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsIndexRedirect'
);
const ProjectSettingsInfrastructure = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsInfrastructure'
);
const ProjectSettingsRuntime = lazyNamed(
  () => import('./pages/ProjectSettings'),
  'ProjectSettingsRuntime'
);
const ProjectSkills = lazyNamed(() => import('./pages/ProjectSkills'), 'ProjectSkills');
const ProjectTriggerDetail = lazyNamed(
  () => import('./pages/ProjectTriggerDetail'),
  'ProjectTriggerDetail'
);
const ProjectTriggers = lazyNamed(() => import('./pages/ProjectTriggers'), 'ProjectTriggers');
const SamPrototype = lazyNamed(() => import('./pages/SamPrototype'), 'SamPrototype');
const Settings = lazyNamed(() => import('./pages/Settings'), 'Settings');
const SettingsAgents = lazyNamed(() => import('./pages/SettingsAgents'), 'SettingsAgents');
const SettingsApiTokens = lazyNamed(() => import('./pages/SettingsApiTokens'), 'SettingsApiTokens');
const SettingsCloudProvider = lazyNamed(
  () => import('./pages/SettingsCloudProvider'),
  'SettingsCloudProvider'
);
const SettingsComputeUsage = lazyNamed(
  () => import('./pages/SettingsComputeUsage'),
  'SettingsComputeUsage'
);
const SettingsConnections = lazyNamed(
  () => import('./pages/SettingsConnections'),
  'SettingsConnections'
);
const SettingsCredentials = lazyNamed(
  () => import('./pages/SettingsCredentials'),
  'SettingsCredentials'
);
const SettingsGitHub = lazyNamed(() => import('./pages/SettingsGitHub'), 'SettingsGitHub');
const SettingsNotifications = lazyNamed(
  () => import('./pages/SettingsNotifications'),
  'SettingsNotifications'
);
const Setup = lazyNamed(() => import('./pages/Setup'), 'Setup');
const TaskRedirect = lazyNamed(() => import('./pages/TaskRedirect'), 'TaskRedirect');
const Tools = lazyNamed(() => import('./pages/Tools'), 'Tools');
const ToolsCli = lazyNamed(() => import('./pages/ToolsCli'), 'ToolsCli');
const TrialChatGateHarness = lazyNamed(
  () => import('./pages/TrialChatGateHarness'),
  'TrialChatGateHarness'
);
const Try = lazyNamed(() => import('./pages/Try'), 'Try');
const TryCapExceeded = lazyNamed(() => import('./pages/TryCapExceeded'), 'TryCapExceeded');
const TryDiscovery = lazyNamed(() => import('./pages/TryDiscovery'), 'TryDiscovery');
const TryWaitlistThanks = lazyNamed(() => import('./pages/TryWaitlistThanks'), 'TryWaitlistThanks');
const UiStandards = lazyNamed(() => import('./pages/UiStandards'), 'UiStandards');
const Workspace = lazyNamed(() => import('./pages/workspace'), 'Workspace');
const Workspaces = lazyNamed(() => import('./pages/Workspaces'), 'Workspaces');

/**
 * Wrap a code-split route element in its own Suspense boundary.
 *
 * The boundary is per route (not one shared boundary around `<Routes>`) so a chunk
 * fetch can only ever replace that route's own slot. Parent layouts — `AppShell`, the
 * `Project` shell — stay mounted, satisfying
 * `.claude/rules/48-stale-while-revalidate-ui.md`: a fallback must never unmount
 * already-rendered content.
 */
function page(element: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
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

function SuperadminRoute({ children }: { children: ReactNode }) {
  const { isSuperadmin } = useAuth();

  if (!isSuperadmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

export const DEV_ONLY_ROUTE_PATHS = [
  '/sam',
  '/__test/trial-chat-gate',
  '/__test/error-boundary',
  '/ui-standards',
] as const;

/** TEMP audit-only harness — forces ErrorBoundary crash screen for Playwright review. Reverted after use. */
function ErrorBoundaryAuditHarness(): never {
  throw new Error('Audit-forced crash: ' + 'x'.repeat(180));
}

export function devOnlyRoutesEnabled() {
  return import.meta.env.DEV || import.meta.env.MODE === 'test';
}

export default function App() {
  const showDevOnlyRoutes = devOnlyRoutesEnabled();

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BackgroundFetchIndicator />
          <AuthProvider>
            <ToastProvider>
              <GlobalAudioProvider>
                <BrowserRouter>
                  <PageViewTracker />
                  <Routes>
                    {/* Public routes */}
                    <Route path="/" element={<Landing />} />
                    <Route path="/try" element={page(<Try />)} />
                    <Route path="/try/cap-exceeded" element={page(<TryCapExceeded />)} />
                    <Route path="/try/waitlist/thanks" element={page(<TryWaitlistThanks />)} />
                    <Route path="/try/:trialId" element={page(<TryDiscovery />)} />
                    <Route path="/device" element={page(<DeviceAuth />)} />
                    <Route path="/setup" element={page(<Setup />)} />
                    {showDevOnlyRoutes && (
                      <>
                        {/* SAM prototype — local/test only, no auth */}
                        <Route path="/sam" element={page(<SamPrototype />)} />
                        {/* Harness for Playwright audits — mounts trial components with mock data */}
                        <Route
                          path="/__test/trial-chat-gate"
                          element={page(<TrialChatGateHarness />)}
                        />
                        <Route
                          path="/__test/error-boundary"
                          element={<ErrorBoundaryAuditHarness />}
                        />
                      </>
                    )}
                    {/* Protected routes with AppShell (persistent navigation) */}
                    <Route element={<ProtectedLayout />}>
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/chats" element={page(<Chats />)} />
                      <Route path="/projects" element={page(<Projects />)} />
                      <Route path="/projects/new" element={page(<ProjectCreate />)} />
                      <Route path="/projects/invite/:token" element={page(<ProjectInvite />)} />

                      {/* Project detail — shell with sub-routes */}
                      <Route path="/projects/:id" element={page(<Project />)}>
                        <Route index element={<Navigate to="chat" replace />} />
                        <Route path="chat" element={page(<ProjectChat />)} />
                        <Route path="chat/:sessionId" element={page(<ProjectChat />)} />
                        <Route path="agent" element={page(<ProjectAgentChat />)} />
                        <Route path="library" element={page(<ProjectLibrary />)} />
                        <Route path="files" element={page(<ProjectFiles />)} />
                        <Route path="ideas" element={page(<IdeasPage />)} />
                        <Route path="deployments" element={page(<ProjectDeployments />)} />
                        <Route
                          path="deployments/:envId"
                          element={page(<ProjectDeploymentEnvironmentDetail />)}
                        />
                        <Route path="agent-context" element={page(<AgentContextPage />)} />
                        <Route
                          path="knowledge"
                          element={<Navigate to="../agent-context" replace />}
                        />
                        <Route path="ideas/:taskId" element={page(<IdeaDetailPage />)} />
                        <Route path="tasks" element={<Navigate to="../ideas" replace />} />
                        <Route path="tasks/:taskId" element={page(<TaskRedirect />)} />
                        <Route path="settings" element={page(<ProjectSettings />)}>
                          <Route index element={page(<ProjectSettingsIndexRedirect />)} />
                          <Route path="general" element={page(<ProjectSettingsGeneral />)} />
                          <Route path="access" element={page(<ProjectSettingsAccess />)} />
                          <Route
                            path="connections"
                            element={page(<ProjectSettingsConnections />)}
                          />
                          <Route path="agents" element={page(<ProjectSettingsAgents />)} />
                          <Route
                            path="infrastructure"
                            element={page(<ProjectSettingsInfrastructure />)}
                          />
                          <Route path="runtime" element={page(<ProjectSettingsRuntime />)} />
                          <Route path="deploy" element={page(<ProjectSettingsDeploy />)} />
                        </Route>
                        <Route path="activity" element={page(<ProjectActivity />)} />
                        <Route path="notifications" element={page(<ProjectNotifications />)} />
                        <Route path="triggers" element={page(<ProjectTriggers />)} />
                        <Route
                          path="triggers/:triggerId"
                          element={page(<ProjectTriggerDetail />)}
                        />
                        <Route path="profiles" element={page(<ProjectProfiles />)} />
                        <Route path="skills" element={page(<ProjectSkills />)} />
                      </Route>

                      <Route path="/nodes" element={page(<Nodes />)} />
                      <Route path="/nodes/:id" element={page(<Node />)} />
                      <Route path="/workspaces" element={page(<Workspaces />)} />
                      <Route path="/workspaces/new" element={page(<CreateWorkspace />)} />
                      <Route path="/settings" element={page(<Settings />)}>
                        <Route index element={<Navigate to="cloud-provider" replace />} />
                        <Route path="cloud-provider" element={page(<SettingsCloudProvider />)} />
                        <Route path="github" element={page(<SettingsGitHub />)} />
                        <Route path="connections" element={page(<SettingsConnections />)} />
                        <Route path="agents" element={page(<SettingsAgents />)} />
                        <Route
                          path="agent-keys"
                          element={<Navigate to="../connections" replace />}
                        />
                        <Route
                          path="agent-config"
                          element={<Navigate to="../connections" replace />}
                        />
                        <Route path="notifications" element={page(<SettingsNotifications />)} />
                        <Route path="usage" element={page(<SettingsComputeUsage />)} />
                        <Route path="api-tokens" element={page(<SettingsApiTokens />)} />
                        <Route path="advanced" element={page(<SettingsCredentials />)} />
                        <Route path="credentials" element={<Navigate to="../advanced" replace />} />
                      </Route>
                      <Route path="/account-map" element={page(<AccountMap />)} />
                      <Route path="/tools" element={page(<Tools />)} />
                      <Route path="/tools/cli" element={page(<ToolsCli />)} />
                      {showDevOnlyRoutes && (
                        <Route path="/ui-standards" element={page(<UiStandards />)} />
                      )}
                      <Route
                        path="/admin"
                        element={<SuperadminRoute>{page(<Admin />)}</SuperadminRoute>}
                      >
                        <Route index element={<Navigate to="users" replace />} />
                        <Route path="users" element={page(<AdminUsers />)} />
                        <Route path="integrations" element={page(<AdminPlatformConfig />)} />
                        <Route path="credentials" element={page(<AdminPlatformCredentials />)} />
                        <Route path="ai-proxy" element={page(<AdminAIProxy />)} />
                        <Route path="trials" element={page(<AdminTrials />)} />
                        <Route path="costs" element={page(<AdminCosts />)} />
                        <Route path="usage" element={page(<AdminComputeUsage />)} />
                        <Route path="quotas" element={page(<AdminComputeQuotas />)} />
                        <Route path="errors" element={page(<AdminErrors />)} />
                        <Route path="diagnoses" element={page(<AdminDiagnoses />)} />
                        <Route path="diagnoses/:runId" element={page(<AdminDiagnosis />)} />
                        <Route path="overview" element={page(<AdminOverview />)} />
                        <Route path="logs" element={page(<AdminLogs />)} />
                        <Route path="stream" element={page(<AdminStream />)} />
                        <Route path="analytics" element={page(<AdminAnalytics />)} />
                      </Route>
                    </Route>

                    {/* Workspace — NO AppShell (full-width terminal) */}
                    <Route
                      path="/workspaces/:id"
                      element={<ProtectedRoute>{page(<Workspace />)}</ProtectedRoute>}
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
