import { useNavigate } from 'react-router-dom';
import type { Task } from '@simple-agent-manager/shared';
import { TaskKanbanBoard } from '../components/task/TaskKanbanBoard';
import { useProjectContext } from './ProjectContext';

export function ProjectKanban() {
  const navigate = useNavigate();
  const { projectId } = useProjectContext();

  const handleTaskClick = (task: Task) => {
    // Navigate to task detail
    navigate(`/projects/${projectId}/tasks/${task.id}`);
  };

  return (
    <div style={{ overflow: 'hidden' }}>
      <TaskKanbanBoard
        projectId={projectId}
        onTaskClick={handleTaskClick}
      />
    </div>
  );
}
