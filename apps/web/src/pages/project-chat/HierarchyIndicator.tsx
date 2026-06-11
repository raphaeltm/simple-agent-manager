import { GitBranch, GitMerge, Network } from 'lucide-react';

import { hasHierarchy } from '../../components/task-hierarchy';
import type { TaskInfo } from './useTaskGroups';

export type HierarchyRole = 'parent' | 'child' | 'both' | 'none';

/**
 * Determine the hierarchy role of a task:
 * - parent: has children but no parent (is not itself a subtask)
 * - child: has a parent but no children
 * - both: has both a parent and children
 * - none: standalone task with no hierarchy
 */
export function getHierarchyRole(
  taskId: string | undefined,
  taskInfoMap: Map<string, TaskInfo>,
): HierarchyRole {
  if (!taskId) return 'none';
  const info = taskInfoMap.get(taskId);
  if (!info) return 'none';

  // Check if this is a genuine subtask child (not a retry/fork)
  const isChild = !!info.parentTaskId && info.triggeredBy === 'mcp';

  // Check if this task has genuine subtask children
  let isParent = false;
  for (const [, other] of taskInfoMap) {
    if (other.parentTaskId === taskId && other.triggeredBy === 'mcp') {
      isParent = true;
      break;
    }
  }

  if (isParent && isChild) return 'both';
  if (isParent) return 'parent';
  if (isChild) return 'child';
  return 'none';
}

/** Compact hierarchy trigger size for dense chat-list rows. */
const HIERARCHY_BUTTON_SIZE_PX = 22;

const ROLE_CONFIG = {
  parent: {
    icon: GitBranch,
    color: 'var(--sam-color-info, #3b82f6)',
    title: 'Has subtasks',
    bgAlpha: '10%',
    hoverBgAlpha: '20%',
  },
  child: {
    icon: GitMerge,
    color: '#a78bfa',
    title: 'Subtask',
    bgAlpha: '10%',
    hoverBgAlpha: '20%',
  },
  both: {
    icon: Network,
    color: 'var(--sam-color-warning, #f59e0b)',
    title: 'Has parent & subtasks',
    bgAlpha: '10%',
    hoverBgAlpha: '20%',
  },
} as const;

/**
 * Role-differentiated hierarchy button that opens the hierarchy modal.
 *
 * - GitBranch (blue) = parent ("Has subtasks")
 * - GitMerge (purple) = child ("Subtask")
 * - Network (amber) = both ("Has parent & subtasks")
 */
export function HierarchyIndicator({
  taskId,
  taskInfoMap,
  onShowHierarchy,
}: {
  taskId: string;
  taskInfoMap: Map<string, TaskInfo>;
  onShowHierarchy: (taskId: string) => void;
}) {
  // Only show if the task actually has hierarchy relationships
  if (!hasHierarchy(taskId, taskInfoMap)) return null;

  const role = getHierarchyRole(taskId, taskInfoMap);
  if (role === 'none') return null;

  const cfg = ROLE_CONFIG[role];
  const Icon = cfg.icon;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onShowHierarchy(taskId);
      }}
      title={cfg.title}
      aria-label={cfg.title}
      className="inline-flex items-center justify-center shrink-0 bg-transparent border cursor-pointer p-0 transition-all duration-150"
      style={{
        width: HIERARCHY_BUTTON_SIZE_PX,
        height: HIERARCHY_BUTTON_SIZE_PX,
        borderRadius: 4,
        borderColor: cfg.color,
        color: cfg.color,
        background: `color-mix(in srgb, ${cfg.color} ${cfg.bgAlpha}, transparent)`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background =
          `color-mix(in srgb, ${cfg.color} ${cfg.hoverBgAlpha}, transparent)`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background =
          `color-mix(in srgb, ${cfg.color} ${cfg.bgAlpha}, transparent)`;
      }}
    >
      <Icon size={11} />
    </button>
  );
}
