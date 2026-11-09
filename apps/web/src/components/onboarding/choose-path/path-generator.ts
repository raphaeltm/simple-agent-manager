/**
 * The steps between the answers and a first chat. A step the user's setup already covers is
 * left out, so every step on screen is one the user acts on.
 */
import type { Answers } from './questions';

export type StepId = 'agent' | 'cloud' | 'github' | 'project';

export interface GeneratedStep {
  id: StepId;
  /** Short name for the progress rail. */
  label: string;
  /** SAM's line at the top of the step. */
  title: string;
  description: string;
}

export interface ExistingSetup {
  hasAgent: boolean;
  hasCloud: boolean;
  hasGitHub: boolean;
  hasProject: boolean;
}

const STEPS: Record<StepId, Omit<GeneratedStep, 'id'>> = {
  agent: {
    label: 'Agent',
    title: 'Who should do the coding?',
    description: "Pick an agent and sign in with its subscription. I'll keep the keys encrypted.",
  },
  cloud: {
    label: 'Cloud',
    title: 'Which cloud should I use?',
    description: 'I start a machine for each agent and remove it when the work is done.',
  },
  github: {
    label: 'GitHub',
    title: 'Let me into GitHub',
    description: 'Install the SAM app on the repositories you choose. Agents open pull requests.',
  },
  project: {
    label: 'Project',
    title: 'What are we building?',
    description: 'A project is where your chats, agents and code come together.',
  },
};

export function generatePath(answers: Answers, existing: ExistingSetup): GeneratedStep[] {
  const ids: StepId[] = [];
  if (!existing.hasAgent) ids.push('agent');
  if (answers.runtime === 'byoc' && !existing.hasCloud) ids.push('cloud');
  if (answers.repo === 'github' && !existing.hasGitHub) ids.push('github');
  if (!existing.hasProject) ids.push('project');
  return ids.map((id) => ({ id, ...STEPS[id] }));
}
