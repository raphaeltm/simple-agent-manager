/**
 * The webhook part of the create/edit form state: who is calling (which decides how SAM
 * verifies the call), where the sender's event ID is, and the conditions.
 */
import {
  SLACK_WEBHOOK_DEFAULTS,
  type WebhookTriggerConfig,
  type WebhookTriggerFilter,
} from '@simple-agent-manager/shared';

import { joinList } from '../../../components/triggers/trigger-form-support';
import type { EditorState } from './state';

/** Who calls the webhook: my own script (SAM token), Slack, or another service that signs. */
export type WebhookCaller = 'script' | 'slack' | 'signed';

export interface WebhookState {
  /** Chosen at creation; decides the verification scheme, which cannot change afterwards. */
  caller: WebhookCaller;
  /** `signed` only: the header carrying the HMAC-SHA256 of the raw body. */
  signatureHeader: string;
  /** Signed callers: where the sender's event ID is (the duplicate key). */
  eventIdSource: 'header' | 'path';
  eventIdKey: string;
  sourceLabel: string;
  includedHeaders: string;
  filterMode: 'all' | 'any';
  filters: WebhookTriggerFilter[];
}

export const DEFAULT_WEBHOOK: WebhookState = {
  caller: 'script',
  signatureHeader: '',
  eventIdSource: 'header',
  eventIdKey: '',
  sourceLabel: '',
  includedHeaders: '',
  filterMode: 'all',
  filters: [],
};

const slackFilters = (): WebhookTriggerFilter[] =>
  SLACK_WEBHOOK_DEFAULTS.filters.map((filter) => ({ ...filter }));
const sameFilters = (a: WebhookTriggerFilter[], b: WebhookTriggerFilter[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a "who is calling?" choice. Picking Slack fills in what Slack needs (where its event
 * ID is, conditions that start a run only for a mention that did not come from a bot, and
 * starting instructions) without overwriting anything the person typed; leaving Slack removes
 * only what was filled in and left untouched. A pure function called from the choice handler,
 * never from an effect.
 */
export function withWebhookCaller(state: EditorState, caller: WebhookCaller): EditorState {
  const previous = state.webhook.caller;
  if (previous === caller) return state;
  let { filters, filterMode, eventIdSource, eventIdKey } = state.webhook;
  let prompt = state.action.prompt;
  if (previous === 'slack') {
    if (sameFilters(filters, slackFilters())) filters = [];
    if (prompt === SLACK_WEBHOOK_DEFAULTS.promptTemplate) prompt = '';
    if (eventIdSource === 'path' && eventIdKey === SLACK_WEBHOOK_DEFAULTS.eventId.path) {
      eventIdSource = 'header';
      eventIdKey = '';
    }
  }
  if (caller === 'slack') {
    if (filters.length === 0) {
      filters = slackFilters();
      filterMode = SLACK_WEBHOOK_DEFAULTS.filterMode;
    }
    if (!prompt.trim()) prompt = SLACK_WEBHOOK_DEFAULTS.promptTemplate;
    eventIdSource = 'path';
    eventIdKey = SLACK_WEBHOOK_DEFAULTS.eventId.path;
  }
  return {
    ...state,
    webhook: { ...state.webhook, caller, filters, filterMode, eventIdSource, eventIdKey },
    action: prompt === state.action.prompt ? state.action : { ...state.action, prompt },
  };
}

export function webhookStateFrom(config: WebhookTriggerConfig): WebhookState {
  // A response cached from before signed webhooks existed has neither field.
  const verification = config.verification ?? { scheme: 'sam_bearer' };
  const eventId = config.eventId ?? null;
  return {
    caller:
      verification.scheme === 'slack_v0'
        ? 'slack'
        : verification.scheme === 'hmac_sha256_body'
          ? 'signed'
          : 'script',
    signatureHeader: verification.scheme === 'hmac_sha256_body' ? verification.header : '',
    eventIdSource: eventId && 'path' in eventId ? 'path' : 'header',
    eventIdKey: eventId ? ('path' in eventId ? eventId.path : eventId.header) : '',
    sourceLabel: config.sourceLabel ?? '',
    includedHeaders: joinList(config.includedHeaders),
    filterMode: config.filterMode,
    filters: config.filters,
  };
}

/** GitHub events and signed webhook events wait in line; other kinds skip while one is busy. */
export function eventsWaitInLine(state: EditorState): boolean {
  return (
    state.start === 'github' || (state.start === 'webhook' && state.webhook.caller !== 'script')
  );
}
