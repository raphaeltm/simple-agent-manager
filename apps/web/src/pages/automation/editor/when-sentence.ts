/** The one-line, plain-language summary of what starts an automation being edited. */
import { describeCron } from '../../../components/triggers/schedule-cron';
import {
  describeEventFilter,
  emailTriggerWhen,
  githubTriggerWhen,
  INCIDENT_TRIGGER_WHEN,
  webhookTriggerWhen,
} from '../describe';
import { resolveOnceTime } from '../schedule-time';
import { fullDate, viewerZone } from '../time';
import { toCron } from './cron';
import { watchFilter } from './requests';
import type { EditorState } from './state';

/** "Weekdays at 9:00 AM (Europe/Paris time)", "When an issue is opened", … */
export function whenSentence(state: EditorState): string {
  switch (state.start) {
    case 'schedule': {
      const cron = toCron(state.schedule);
      const described = describeCron(cron);
      const text =
        described === cron || described === 'Invalid expression'
          ? `On the schedule ${cron}`
          : described;
      return state.schedule.zone === viewerZone() ? text : `${text} (${state.schedule.zone} time)`;
    }
    case 'once': {
      const time = resolveOnceTime(state.once);
      return 'dueAt' in time ? `On ${fullDate(time.dueAt, state.once.zone)}` : 'Once';
    }
    case 'github':
      return githubTriggerWhen(state.github.eventType, {
        actions: state.github.actions
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        commandPrefix:
          state.github.eventType === 'issue_comment' ? state.github.commandPrefix : undefined,
        branches: state.github.branches
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
    case 'webhook':
      return webhookTriggerWhen(state.webhook.sourceLabel);
    case 'email':
      return emailTriggerWhen(null);
    case 'event':
      return `When ${describeEventFilter(watchFilter(state)).clause}`;
    case 'incident':
      return INCIDENT_TRIGGER_WHEN;
    default:
      return '';
  }
}
