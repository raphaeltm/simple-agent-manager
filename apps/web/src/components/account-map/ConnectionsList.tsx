/**
 * Phone Account Map: columns do not fit, so chats and tasks are grouped by project, and picking
 * one opens its chain (idea → workspace → machine → pull request) underneath it.
 */
import { Link } from 'react-router';

import { projectPath } from '../../lib/project-routes';
import type { ConnectionsModel, ConnectionsView } from './connections-model';
import { machineOf } from './connections-model';
import { machineState, ProjectMark, WorkRow, WorkStateChip } from './connections-parts';
import { ConnectionsPathSteps } from './ConnectionsPath';

export function ConnectionsList({
  model,
  view,
  selectedId,
  onSelect,
  showQuiet,
  onToggleQuiet,
}: {
  model: ConnectionsModel;
  view: ConnectionsView;
  selectedId: string | null;
  onSelect: (id: string) => void;
  showQuiet: boolean;
  onToggleQuiet: () => void;
}) {
  const all = view.projects.map((project) => ({
    project,
    work: view.work.filter((w) => w.projectId === project.id),
  }));
  const groups = all.filter((g) => g.work.length > 0);
  // The list is grouped by work, so projects with none (including ones that only hold a
  // workspace) sit behind the same "quiet projects" toggle the columns have.
  const quiet = [
    ...all.filter((g) => g.work.length === 0).map((g) => g.project),
    ...view.quietProjects,
  ];

  return (
    <div className="flex flex-col gap-2.5">
      {groups.length === 0 && (
        <p className="m-0 px-1 text-[13px] text-fg-muted">No chats or tasks match.</p>
      )}
      {groups.map(({ project, work }) => (
        <section
          key={project.id}
          aria-label={project.name}
          className="rounded-[var(--sam-radius-pane)] border border-solid border-[var(--sam-hairline)] px-3 py-3"
        >
          <h2 className="m-0 mb-2 flex min-w-0 items-center gap-2 px-1 text-[14px] font-semibold text-fg-primary">
            <ProjectMark name={project.name} />
            <span className="line-clamp-2 min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
              {project.name}
            </span>
          </h2>
          <div className="flex flex-col gap-2">
            {work.map((w) => {
              const machine = machineOf(model, w.workspaceId);
              const open = selectedId === w.id;
              const state = machine ? machineState(machine) : null;
              return (
                <div key={w.id}>
                  <WorkRow model={model} work={w} dim={false} selected={open} onSelect={onSelect} />
                  {open ? (
                    <div className="px-1 pt-2">
                      <div className="pb-2">
                        <WorkStateChip state={w.state} />
                      </div>
                      <ConnectionsPathSteps model={model} work={w} />
                    </div>
                  ) : (
                    <p
                      className={`m-0 truncate px-3 pt-1 text-[11.5px] ${
                        state?.tone === 'danger'
                          ? 'text-[var(--sam-status-danger-fg)]'
                          : 'text-fg-muted'
                      }`}
                    >
                      {machine
                        ? `on ${machine.placeholder ? 'Instant' : machine.name}${state?.tone === 'danger' ? ` · ${state.label.toLowerCase()}` : ''}`
                        : 'not running anywhere'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {quiet.length > 0 && (
        <button
          type="button"
          aria-expanded={showQuiet}
          onClick={onToggleQuiet}
          className="min-h-11 cursor-pointer rounded-[var(--sam-radius-control)] border-0 bg-transparent px-1 text-left text-[13px] text-fg-muted hover:text-fg-primary"
        >
          {showQuiet ? 'Hide quiet projects' : `Show ${quiet.length} quiet projects`}
        </button>
      )}
      {showQuiet && quiet.length > 0 && (
        <ul aria-label="Quiet projects" className="m-0 flex list-none flex-col gap-1 p-0">
          {quiet.map((project) => (
            <li key={project.id}>
              <Link
                to={projectPath(project.id)}
                className="flex min-h-11 min-w-0 items-center gap-2 rounded-[var(--sam-radius-control)] px-2 text-[13.5px] text-fg-primary no-underline hover:bg-[var(--sam-chip-bg)]"
              >
                <ProjectMark name={project.name} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
