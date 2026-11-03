import {
  type AdminSettingDefinition,
  choiceDefinition,
  integerDefinition,
  MAX_SAM_OPERATOR_EVENT_PAGE_SIZE,
  OPERATOR_DEFAULTS,
} from './admin-setting-definitions';
/** Operations-project debugger tools dial (idea 01M6GGY1QPGG4D40HG0PVGQS3R, policy a35180d5). */
export const OPERATIONS_TOOLS_MODES = ['off', 'read', 'read_ask', 'read_auto_safe'] as const;
export const DEFAULT_OPERATIONS_AUDIT_RETENTION_DAYS = 90;

export const OPERATOR_SETTINGS: AdminSettingDefinition[] = [
  choiceDefinition(
    'operations.debuggerTools',
    'off',
    OPERATIONS_TOOLS_MODES,
    'Operations',
    'Debugger tools for agents in the Operations project. off: none. read: read-only fleet and node diagnostics, including raw node logs. read_ask: read, plus actions that each need a human approval. read_auto_safe: read_ask, but retrying a snapshot and re-running node cleanup run without approval. Only tasks owned by a current superadmin can use them.'
  ),
  integerDefinition(
    'operations.auditRetentionDays',
    DEFAULT_OPERATIONS_AUDIT_RETENTION_DAYS,
    'Operations',
    'Days an Operations debugger tool audit row is kept before the daily purge deletes it.',
    { min: 1, max: 3_650 }
  ),
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
