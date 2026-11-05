/**
 * The picked item's chain, spelled out: project → idea → chat or task → workspace → machine →
 * pull request. A row of steps on desktop, a vertical list under the row on phones.
 */
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';

import {
  projectChatPath,
  projectIdeaPath,
  projectPath,
  projectTaskPath,
} from '../../lib/project-routes';
import { type ConnectionsModel, machineOf, type MapWork, workspaceOf } from './connections-model';
import { machineDetail, prLabel, WORK_STATE_LABEL } from './connections-parts';

interface PathStep {
  key: string;
  label: string;
  value: string;
  to?: string;
  /** External https link (pull requests). */
  href?: string;
  mono?: boolean;
}

function workPath(model: ConnectionsModel, work: MapWork): PathStep[] {
  const project = model.projects.find((p) => p.id === work.projectId);
  const workspace = workspaceOf(model, work.workspaceId);
  const machine = machineOf(model, work.workspaceId);
  const steps: PathStep[] = [
    {
      key: 'project',
      label: 'Project',
      value: project?.name ?? 'Unknown project',
      to: projectPath(work.projectId),
    },
  ];
  for (const ideaId of work.ideaIds) {
    const idea = model.ideas.get(ideaId);
    if (idea)
      steps.push({
        key: `idea-${idea.id}`,
        label: 'Idea',
        value: idea.title,
        to: projectIdeaPath(idea.projectId, idea.id),
      });
  }
  steps.push({
    key: 'work',
    label: `${work.kind === 'task' ? 'Task' : 'Chat'} · ${WORK_STATE_LABEL[work.state]}`,
    value: work.attentionReason ? `${work.title}: ${work.attentionReason}` : work.title,
    to: work.sessionId
      ? projectChatPath(work.projectId, work.sessionId)
      : work.taskId
        ? projectTaskPath(work.projectId, work.taskId)
        : undefined,
  });
  steps.push(
    workspace
      ? { key: 'workspace', label: 'Workspace', value: workspace.label, mono: true }
      : { key: 'workspace', label: 'Workspace', value: 'None right now' }
  );
  if (machine) {
    steps.push({
      key: 'machine',
      label: 'Machine',
      value: machine.placeholder
        ? machineDetail(machine)
        : `${machine.name} · ${machineDetail(machine)}`,
      to: machine.placeholder ? undefined : `/nodes/${encodeURIComponent(machine.id)}`,
    });
  }
  if (work.prUrl)
    steps.push({ key: 'pr', label: 'Pull request', value: prLabel(work.prUrl), href: work.prUrl });
  return steps;
}

/** One sentence for a picked project or machine, which have many chains rather than one. */
function summary(model: ConnectionsModel, id: string | null): string {
  const machine = model.machines.find((m) => m.id === id);
  if (machine) {
    const count = machine.workspaces.length;
    return `${machine.name} runs ${count} ${count === 1 ? 'workspace' : 'workspaces'} · ${machineDetail(machine)}`;
  }
  const project = model.projects.find((p) => p.id === id);
  if (project) {
    const count = model.work.filter((w) => w.projectId === id).length;
    return `${project.name}: ${count} ${count === 1 ? 'chat or task' : 'chats and tasks'} on the map`;
  }
  return 'Pick a chat, project or machine to see how it connects.';
}

function StepValue({ step, className }: { step: PathStep; className: string }) {
  if (step.to) {
    return (
      <Link
        to={step.to}
        className={`${className} text-fg-primary underline decoration-[var(--sam-hairline)] underline-offset-2 hover:decoration-current`}
      >
        {step.value}
      </Link>
    );
  }
  if (step.href) {
    return (
      <a
        href={step.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} text-fg-primary underline decoration-[var(--sam-hairline)] underline-offset-2 hover:decoration-current`}
      >
        {step.value}
      </a>
    );
  }
  return <span className={`${className} text-fg-primary`}>{step.value}</span>;
}

export function ConnectionsPathBar({
  model,
  selectedId,
}: {
  model: ConnectionsModel;
  selectedId: string | null;
}) {
  const work = model.work.find((w) => w.id === selectedId);
  if (!work) {
    return (
      <p className="m-0 min-w-0 break-words text-[13px] text-fg-muted">
        {summary(model, selectedId)}
      </p>
    );
  }
  return (
    <ol
      aria-label="How this connects"
      className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0"
    >
      {workPath(model, work).map((step, i) => (
        <li key={step.key} className="flex min-w-0 max-w-full items-center gap-1.5">
          {i > 0 && <ArrowRight size={13} aria-hidden="true" className="shrink-0 text-fg-muted" />}
          <span className="sam-well min-w-0 max-w-[320px] rounded-[var(--sam-radius-control)] px-2.5 py-1">
            <span className="block text-[10px] uppercase tracking-wide text-fg-muted">
              {step.label}
            </span>
            <StepValue
              step={step}
              className={`block truncate text-[12.5px] ${step.mono ? 'font-mono' : ''}`}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The phone version: the chain as a vertical list, below the picked row. */
export function ConnectionsPathSteps({ model, work }: { model: ConnectionsModel; work: MapWork }) {
  return (
    <ol
      aria-label="How this connects"
      className="m-0 list-none border-0 border-l-2 border-solid border-[var(--sam-success-edge)] p-0 pl-3"
    >
      {workPath(model, work).map((step) => (
        <li key={step.key} className="pb-2">
          <span className="block text-[10px] uppercase tracking-wide text-fg-muted">
            {step.label}
          </span>
          <StepValue
            step={step}
            className={`block break-words text-[13px] [overflow-wrap:anywhere] ${step.mono ? 'font-mono' : ''}`}
          />
        </li>
      ))}
    </ol>
  );
}
