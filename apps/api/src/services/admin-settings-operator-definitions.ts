import {
  type AdminSettingDefinition,
  integerDefinition,
  MAX_SAM_OPERATOR_EVENT_PAGE_SIZE,
  OPERATOR_DEFAULTS,
} from './admin-setting-definitions';
export const OPERATOR_SETTINGS: AdminSettingDefinition[] = [
  integerDefinition(
    'operations.samOperatorWatchLifetimeMs',
    OPERATOR_DEFAULTS.watchLifetimeMs,
    'Operations',
    'Maximum lifetime in milliseconds of private SAM project-work watches.',
    { min: 1, max: 2_147_483_647 }
  ),
  integerDefinition(
    'operations.samOperatorEventPageSize',
    OPERATOR_DEFAULTS.eventPageSize,
    'Operations',
    'Maximum watches per refresh, events per watch, and visible private SAM work cards.',
    { min: 1, max: MAX_SAM_OPERATOR_EVENT_PAGE_SIZE }
  ),
  integerDefinition(
    'operations.samOperatorWorkRefreshMs',
    OPERATOR_DEFAULTS.workRefreshMs,
    'Operations',
    'Milliseconds between private SAM project-work refreshes.',
    { min: 1_000, max: 2_147_483_647 }
  ),
  integerDefinition(
    'operations.samOperatorWatchRetryLimit',
    OPERATOR_DEFAULTS.watchRetryLimit,
    'Operations',
    'Consecutive failed private SAM watch refreshes before automatic updates stop. A successful pull or requested follow-up resets the count.',
    { min: 1, max: 25 }
  ),
  integerDefinition(
    'operations.samOperatorStreamFlushMs',
    OPERATOR_DEFAULTS.streamFlushMs,
    'Operations',
    'Milliseconds between live updates while the private SAM assistant is answering.',
    { min: 16, max: 2_000 }
  ),
  integerDefinition(
    'operations.samOperatorStreamHeartbeatMs',
    OPERATOR_DEFAULTS.streamHeartbeatMs,
    'Operations',
    'Milliseconds between keep-alive frames on a live SAM answer stream.',
    { min: 1_000, max: 120_000 }
  ),
  integerDefinition(
    'operations.samOperatorStreamMaxSubscribers',
    OPERATOR_DEFAULTS.streamMaxSubscribers,
    'Operations',
    'Browser tabs that can follow one private SAM answer live at the same time.',
    { min: 1, max: 20 }
  ),
];
