import { Alert, Button, EmptyState, PageLayout, SkeletonCard, Spinner } from '@simple-agent-manager/ui';
import { useNavigate } from 'react-router-dom';

import { ActiveTaskCard } from '../components/ActiveTaskCard';
import { useAuth } from '../components/AuthProvider';
import { OnboardingWizard } from '../components/onboarding';
import { ProjectSummaryCard } from '../components/ProjectSummaryCard';
import { UserMenu } from '../components/UserMenu';
import { useActiveTasks } from '../hooks/useActiveTasks';
import { useProjectList } from '../hooks/useProjectData';

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { tasks, loading: tasksLoading, isRefreshing: tasksRefreshing, error: tasksError, refresh: refreshTasks } = useActiveTasks();
  const { projects, loading: projectsLoading, isRefreshing: projectsRefreshing, error: projectsError, refresh: refreshProjects } = useProjectList({ sort: 'last_activity', limit: 50 });

  return (
    <PageLayout
      title="Simple Agent Manager"
      maxWidth="xl"
      headerRight={<UserMenu />}
    >
      {/* Welcome section */}
      <div className="mb-6">
        <h2 className="sam-type-page-title text-fg-primary">
          Welcome, {user?.name || user?.email}!
        </h2>
      </div>

      {/* Onboarding wizard for new users */}
      <OnboardingWizard />

      {/* Error messages */}
      {tasksError && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => void refreshTasks()}>
            {tasksError}
          </Alert>
        </div>
      )}
      {projectsError && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => void refreshProjects()}>
            {projectsError}
          </Alert>
        </div>
      )}

      {/* Active Tasks section */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="sam-type-section-heading m-0 text-fg-primary">Active Tasks</h3>
            {tasksRefreshing && <Spinner size="sm" />}
          </div>
        </div>

        {tasksLoading && tasks.length === 0 ? (
          <div
            role="status"
            aria-label="Loading active tasks"
            aria-busy="true"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} lines={3} />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            heading="No active tasks"
            description="Submit a task from a project to get started."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tasks.map((task) => (
              <ActiveTaskCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>

      {/* Projects section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="sam-type-section-heading m-0 text-fg-primary">Projects</h3>
            {projectsRefreshing && <Spinner size="sm" />}
          </div>
          <Button variant="primary" size="sm" onClick={() => navigate('/projects/new')}>
            Import Project
          </Button>
        </div>

        {projectsLoading && projects.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} lines={2} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            heading="Import your first project"
            description="Connect a GitHub repository to start chatting with an AI coding agent."
            action={{ label: 'Import Project', onClick: () => navigate('/projects/new') }}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <ProjectSummaryCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
