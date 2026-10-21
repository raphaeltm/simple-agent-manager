/**
 * Starting points offered on an empty Automation page. Each fills the create flow; nothing is
 * saved until the person reviews it and presses Create.
 */
import type { AutomationStart } from '../../../lib/automation-routes';
import type { EditorState } from './state';

export interface AutomationTemplate {
  id: string;
  start: AutomationStart;
  title: string;
  text: string;
  apply: (state: EditorState) => EditorState;
}

export const TEMPLATES: AutomationTemplate[] = [
  {
    id: 'pr-summary',
    start: 'schedule',
    title: 'Morning pull request summary',
    text: 'Every weekday at 9, list open pull requests and what each one needs.',
    apply: (state) => ({
      ...state,
      start: 'schedule',
      name: 'Morning pull request summary',
      nameEdited: true,
      schedule: { ...state.schedule, preset: 'weekdays', time: '09:00' },
      scheduleTouched: true,
      action: {
        ...state.action,
        kind: 'start',
        prompt:
          'Summarize the open pull requests: what is ready to merge, what is blocked, and what needs a review. Keep it short.',
      },
    }),
  },
  {
    id: 'issue-triage',
    start: 'github',
    title: 'Triage new issues',
    text: 'When an issue is opened, label it and ask for anything missing.',
    apply: (state) => ({
      ...state,
      start: 'github',
      name: 'Triage new issues',
      nameEdited: true,
      github: {
        ...state.github,
        eventType: 'issues',
        actions: 'opened',
        commandPrefix: '',
        labels: '',
        branches: '',
      },
      action: {
        ...state.action,
        kind: 'start',
        prompt:
          'A new issue was opened: {{github.title}} (#{{github.number}}). Read it, add fitting labels, and comment to ask for anything missing to reproduce it.',
      },
    }),
  },
  {
    id: 'release-failed',
    start: 'event',
    title: 'Look into failed releases',
    text: 'When a release fails, read what happened and explain the cause.',
    apply: (state) => ({
      ...state,
      start: 'event',
      name: 'Look into failed releases',
      nameEdited: true,
      watch: { ...state.watch, preset: 'release-failed' },
      action: {
        ...state.action,
        kind: 'start',
        prompt: 'A release failed. Read its logs, explain what went wrong, and suggest a fix.',
      },
    }),
  },
];

export const templateById = (id: string | null) => TEMPLATES.find((template) => template.id === id);
