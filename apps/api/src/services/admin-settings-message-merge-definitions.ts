import { DEFAULT_MESSAGE_MERGE_CONFIG } from '@simple-agent-manager/project-data';

import {
  type AdminSettingDefinition,
  integerDefinition,
  switchDefinition,
} from './admin-setting-definitions';

export const MESSAGE_MERGE_SETTINGS: AdminSettingDefinition[] = [
  integerDefinition(
    'chat.messageBookkeepingSealLeaseMs',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSealLeaseMs,
    'Operations',
    'Maximum residence of a resumable global legacy compatibility fence. Expiry restarts the bounded scan; accepted sockets retain ordinary compatibility protection.',
    { min: 1000, max: 300_000 }
  ),
  integerDefinition(
    'chat.messageBookkeepingSealMaxSessions',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSealMaxSessions,
    'Operations',
    'Maximum sessions folded and sealed in a legacy project socket handshake; incomplete handshakes return a retryable response.',
    { min: 1, max: 100_000 }
  ),
  integerDefinition(
    'chat.messageBookkeepingSummaryRetryMs',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSummaryRetryMs,
    'Operations',
    'Delay between bounded retries of chat summary publication. Retry eligibility survives object restarts.',
    { min: 1000, max: 300_000 }
  ),
  integerDefinition(
    'chat.messageBookkeepingSummaryMaxAttempts',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSummaryMaxAttempts,
    'Operations',
    'Maximum attempts per unresolved chat summary publication episode before operator-visible quarantine.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'chat.messageBookkeepingSummaryMaxResidenceMs',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingSummaryMaxResidenceMs,
    'Operations',
    'Maximum age of an unresolved chat summary publication episode. Ingest does not renew this budget.',
    { min: 1000, max: 86_400_000 }
  ),
  integerDefinition(
    'chat.messageBookkeepingIntervalMs',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingIntervalMs,
    'Operations',
    'Maximum delay before persisted chat activity is folded into counters and timers. Clamped below half the session idle window; lifecycle boundaries flush immediately.',
    { min: 10_000, max: 30_000 }
  ),
  integerDefinition(
    'chat.messageBookkeepingFlushBatchSize',
    DEFAULT_MESSAGE_MERGE_CONFIG.bookkeepingFlushBatchSize,
    'Operations',
    'Maximum chat bookkeeping rows folded or published by one maintenance pass.',
    { min: 1, max: 1000 }
  ),
  switchDefinition(
    'chat.messageMergingEnabled',
    DEFAULT_MESSAGE_MERGE_CONFIG.enabled,
    'Operations',
    'Merge newly received assistant text chunks. Disable to seal open rows and resume individual inserts.',
    {}
  ),
  integerDefinition(
    'chat.messageMergeMaxRowBytes',
    DEFAULT_MESSAGE_MERGE_CONFIG.maxRowBytes,
    'Operations',
    'Maximum serialized bytes in a merged row and retry-state admission budget; oversized individual messages or retry states keep individual rows.',
    { min: 1024, max: 256 * 1024 }
  ),
  integerDefinition(
    'chat.messageMergeRecentIds',
    DEFAULT_MESSAGE_MERGE_CONFIG.recentIds,
    'Operations',
    'Recent reporter message IDs retained across callback credential rotation; at least a complete received batch is retained.',
    { min: 50, max: 2000 }
  ),
];
